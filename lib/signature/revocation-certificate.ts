// Avaliação de revogação de UM certificado: reúne todas as LCRs e respostas OCSP disponíveis,
// escolhe a melhor evidência e decide o estado do certificado no instante de referência.

import type { ParsedX509Node } from './icp-chain.ts';
import type { CertificateRevocationCheckSummary } from './types.ts';
import {
  type RevocationFreshnessContext,
  freshnessContextFromOptions,
} from './revocation-freshness.ts';
import { evaluateCrlForCertificate } from './revocation-crl.ts';
import { evaluateOcspForCertificate } from './revocation-ocsp.ts';
import {
  type SingleEvidenceEvaluation,
  effectiveRevocationTime,
  requiresConservativeRevocationTime,
} from './revocation-evaluation.ts';

type CertificateRevocationResult = {
  summary: CertificateRevocationCheckSummary;
  rejectedCount: number;
};

/** Identificação do certificado avaliado, repetida em todo resultado. */
type SummaryBase = Pick<
  CertificateRevocationCheckSummary,
  'subject' | 'issuer' | 'serialNumber' | 'role'
>;

/** As avaliações já ordenadas e separadas pelo que cada uma conseguiu provar. */
type EvidenceGroups = {
  validEvaluations: SingleEvidenceEvaluation[];
  notFreshEvaluations: SingleEvidenceEvaluation[];
  invalidEvaluations: SingleEvidenceEvaluation[];
  scopeIncompatibleEvaluations: SingleEvidenceEvaluation[];
  unavailableEvaluations: SingleEvidenceEvaluation[];
  certIdMismatch: SingleEvidenceEvaluation | undefined;
  unavailableSubIndication:
    | 'TSA_REVOCATION_UNAVAILABLE'
    | 'REVOCATION_UNAVAILABLE';
  source: CertificateRevocationCheckSummary['source'];
};

/** As evidências válidas separadas pelo estado que declaram, e se elas se contradizem. */
type EvidenceByStatus = {
  goodEvals: SingleEvidenceEvaluation[];
  revokedEvals: SingleEvidenceEvaluation[];
  holdEvals: SingleEvidenceEvaluation[];
  unknownEvals: SingleEvidenceEvaluation[];
  hasContradictoryEvidence: boolean;
};

/**
 * Evaluates revocation status for a single certificate (`targetNode`, issued by `issuerNode`)
 * across all provided CRLs and OCSP responses, applying ETSI EN 319 102-1 temporal POE semantics.
 *
 * Os passos, na ordem: avaliar cada LCR e cada resposta OCSP; ordenar e separar as avaliações
 * pelo que cada uma provou; se nenhuma evidência serve, dizer por quê; senão, separar pelo
 * estado declarado e decidir nesta prioridade: revogado, suspenso, desconhecido, bom.
 */
export async function evaluateSingleCertificateRevocation(params: {
  targetNode: ParsedX509Node;
  issuerNode: ParsedX509Node;
  role: 'SIGNER' | 'SIGNER_CA' | 'TSA_SIGNER' | 'TSA_CA';
  rawCrls: Array<Buffer | Uint8Array | string>;
  rawOcspResponses: Array<Buffer | Uint8Array | string>;
  extraResponderCerts?: unknown[];
  referenceTime: Date;
  verificationTime: Date;
  hasTrustedCompletePoe: boolean;
  poeTime?: Date;
  /** Política de frescor; padrão: HISTORICAL com POE confiável completa, senão CURRENT. */
  freshness?: RevocationFreshnessContext;
  /** Informational only: signer-declared signingTime is never used as temporal proof. */
  claimedSigningTime?: Date;
  validationContext?: 'VERIFICATION' | 'LIVE_ISSUANCE';
}): Promise<{
  summary: CertificateRevocationCheckSummary;
  rejectedCount: number;
}> {
  const {
    targetNode,
    issuerNode,
    role,
    rawCrls,
    rawOcspResponses,
    extraResponderCerts = [],
    referenceTime,
    verificationTime,
    hasTrustedCompletePoe,
    poeTime,
    validationContext = 'VERIFICATION',
  } = params;
  const freshness =
    params.freshness ??
    freshnessContextFromOptions(
      {},
      hasTrustedCompletePoe && poeTime ? 'HISTORICAL' : 'CURRENT',
    );

  const isCaRole = role === 'SIGNER_CA' || role === 'TSA_CA';
  const isTsaRole = role === 'TSA_SIGNER' || role === 'TSA_CA';
  const base = {
    subject: targetNode.subject,
    issuer: targetNode.issuer,
    serialNumber: targetNode.serialNumber,
    role,
  };

  const evaluations = await collectEvidenceEvaluations({
    targetNode,
    issuerNode,
    rawCrls,
    rawOcspResponses,
    extraResponderCerts,
    referenceTime,
    verificationTime,
    freshness,
  });
  const groups = sortAndGroupEvaluations(evaluations, isTsaRole);

  const withoutEvidence = summaryWithoutValidEvidence({
    base,
    targetNode,
    groups,
  });
  if (withoutEvidence) return withoutEvidence;

  const byStatus = splitByDeclaredStatus({ groups, targetNode });
  const poeProvesBefore = makePoeProvesBefore({
    freshness,
    hasTrustedCompletePoe,
    poeTime,
  });

  const revoked = summaryForRevokedCertificate({
    base,
    targetNode,
    role,
    isCaRole,
    isTsaRole,
    groups,
    byStatus,
    poeProvesBefore,
    poeTime,
    validationContext,
    referenceTime,
    verificationTime,
  });
  if (revoked) return revoked;

  const onHold = summaryForCertificateOnHold({
    base,
    targetNode,
    isTsaRole,
    groups,
    byStatus,
    poeProvesBefore,
  });
  if (onHold) return onHold;

  return summaryForGoodOrUnknown({
    base,
    targetNode,
    groups,
    byStatus,
    freshness,
  });
}

/** Avalia cada LCR e cada resposta OCSP fornecida contra o certificado, uma por uma. */
async function collectEvidenceEvaluations(params: {
  targetNode: ParsedX509Node;
  issuerNode: ParsedX509Node;
  rawCrls: Array<Buffer | Uint8Array | string>;
  rawOcspResponses: Array<Buffer | Uint8Array | string>;
  extraResponderCerts: unknown[];
  referenceTime: Date;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): Promise<SingleEvidenceEvaluation[]> {
  const {
    targetNode,
    issuerNode,
    rawCrls,
    rawOcspResponses,
    extraResponderCerts,
    referenceTime,
    verificationTime,
    freshness,
  } = params;

  const evaluations: SingleEvidenceEvaluation[] = [];
  for (const rawCrl of rawCrls) {
    evaluations.push(
      await evaluateCrlForCertificate({
        rawCrl,
        targetNode,
        issuerNode,
        referenceTime,
        verificationTime,
        freshness,
      }),
    );
  }
  for (const rawOcsp of rawOcspResponses) {
    evaluations.push(
      await evaluateOcspForCertificate({
        rawOcsp,
        targetNode,
        issuerNode,
        extraResponderCerts,
        rawCrls,
        referenceTime,
        verificationTime,
        freshness,
      }),
    );
  }
  return evaluations;
}

/**
 * Ordena as avaliações e as separa pelo que cada uma conseguiu provar. Também diz de onde
 * veio a evidência válida (LCR, OCSP ou as duas).
 */
function sortAndGroupEvaluations(
  evaluations: SingleEvidenceEvaluation[],
  isTsaRole: boolean,
): EvidenceGroups {
  // 6F.2C-R: a ordem de apresentação das evidências nunca influencia o resultado nem a mensagem.
  evaluations.sort(compareEvaluations);
  const byKind = (kind: SingleEvidenceEvaluation['matchKind']) =>
    evaluations.filter((e) => e.matchKind === kind);
  const validEvaluations = byKind('MATCHED_VALID');
  const notFreshEvaluations = byKind('NOT_FRESH');
  const invalidEvaluations = byKind('INVALID_EVIDENCE');
  const scopeIncompatibleEvaluations = byKind('SCOPE_INCOMPATIBLE');
  const unavailableEvaluations = byKind('UNAVAILABLE');
  const certIdMismatch = evaluations.find(
    (e) =>
      e.matchKind === 'UNRELATED_ISSUER' &&
      e.subIndication === 'OCSP_CERT_ID_MISMATCH',
  );
  const unavailableSubIndication = isTsaRole
    ? 'TSA_REVOCATION_UNAVAILABLE'
    : 'REVOCATION_UNAVAILABLE';

  const usedCrl = validEvaluations.some((e) => e.source === 'CRL');
  const usedOcsp = validEvaluations.some((e) => e.source === 'OCSP');
  const source: 'CRL' | 'OCSP' | 'BOTH' | 'NONE' =
    usedCrl && usedOcsp
      ? 'BOTH'
      : usedCrl
        ? 'CRL'
        : usedOcsp
          ? 'OCSP'
          : 'NONE';

  return {
    validEvaluations,
    notFreshEvaluations,
    invalidEvaluations,
    scopeIncompatibleEvaluations,
    unavailableEvaluations,
    certIdMismatch,
    unavailableSubIndication,
    source,
  };
}

/**
 * Sem nenhuma evidência autêntica, aplicável e suficiente, explica o motivo nesta prioridade:
 * evidência inválida, evidência velha demais, LCR de escopo incompatível, evidência
 * indisponível, OCSP sobre outro certificado ou simplesmente ausente. Devolve `null` quando há
 * evidência válida e a decisão segue para os próximos passos.
 */
function summaryWithoutValidEvidence(params: {
  base: SummaryBase;
  targetNode: ParsedX509Node;
  groups: EvidenceGroups;
}): CertificateRevocationResult | null {
  const { base, targetNode } = params;
  const {
    validEvaluations,
    invalidEvaluations,
    notFreshEvaluations,
    scopeIncompatibleEvaluations,
    unavailableEvaluations,
    certIdMismatch,
    unavailableSubIndication,
  } = params.groups;

  // No authentic, applicable and sufficient evidence for this certificate:
  if (validEvaluations.length === 0) {
    if (invalidEvaluations.length > 0) {
      const firstErr = invalidEvaluations[0];
      return {
        summary: {
          ...base,
          status: 'INVALID_EVIDENCE',
          source: 'NONE',
          thisUpdate: firstErr.thisUpdate,
          nextUpdate: firstErr.nextUpdate,
          producedAt: firstErr.producedAt,
          subIndication: 'REVOCATION_EVIDENCE_INVALID',
          error: firstErr.error,
        },
        rejectedCount: invalidEvaluations.length,
      };
    }

    // Authentic "not revoked" evidence that is not fresh enough for the reference time
    // (ETSI EN 319 102-1 §5.2.5.4: INDETERMINATE / TRY_LATER).
    if (notFreshEvaluations.length > 0) {
      const latest = notFreshEvaluations.reduce((a, b) =>
        (b.thisUpdate?.getTime() ?? 0) > (a.thisUpdate?.getTime() ?? 0) ? b : a,
      );
      return {
        summary: {
          ...base,
          status: 'INDETERMINATE',
          source: 'NONE',
          thisUpdate: latest.thisUpdate,
          nextUpdate: latest.nextUpdate,
          producedAt: latest.producedAt,
          subIndication: 'TRY_LATER',
          error: latest.error,
        },
        rejectedCount: 0,
      };
    }

    if (scopeIncompatibleEvaluations.length > 0) {
      const firstScope = scopeIncompatibleEvaluations[0];
      return {
        summary: {
          ...base,
          status: 'INDETERMINATE',
          source: 'NONE',
          thisUpdate: firstScope.thisUpdate,
          nextUpdate: firstScope.nextUpdate,
          subIndication: firstScope.subIndication || 'CRL_SCOPE_INCOMPATIBLE',
          error: firstScope.error,
        },
        rejectedCount: 0,
      };
    }

    if (unavailableEvaluations.length > 0) {
      return {
        summary: {
          ...base,
          status: 'INDETERMINATE',
          source: 'NONE',
          subIndication: 'TRY_LATER',
          error: unavailableEvaluations[0].error,
        },
        rejectedCount: 0,
      };
    }

    if (certIdMismatch) {
      // An OCSP response about another certificate/issuer is simply not applicable evidence
      // for this certificate (it may legitimately cover another chain member). It is never
      // accepted as substitute evidence; the status stays INDETERMINATE for lack of evidence.
      return {
        summary: {
          ...base,
          status: 'INDETERMINATE',
          source: 'NONE',
          subIndication: unavailableSubIndication,
          error:
            certIdMismatch.error ||
            `Resposta OCSP refere-se a outro certificado ou emissor, não a "${targetNode.commonName}".`,
        },
        rejectedCount: 0,
      };
    }

    return {
      summary: {
        ...base,
        status: 'INDETERMINATE',
        source: 'NONE',
        subIndication: unavailableSubIndication,
        error: `Evidência de revogação (CRL/OCSP) ausente para "${targetNode.commonName}".`,
      },
      rejectedCount: 0,
    };
  }
  return null;
}

/**
 * Separa as evidências válidas pelo estado que declaram (bom, revogado, suspenso, desconhecido)
 * e verifica se elas se contradizem.
 */
function splitByDeclaredStatus(params: {
  groups: EvidenceGroups;
  targetNode: ParsedX509Node;
}): EvidenceByStatus {
  const { targetNode } = params;
  const { validEvaluations, notFreshEvaluations } = params.groups;

  const goodEvals = validEvaluations.filter((e) => e.certStatus === 'GOOD');
  const revokedEvals = validEvaluations.filter(
    (e) => e.certStatus === 'REVOKED',
  );
  const holdEvals = validEvaluations.filter(
    (e) => e.certStatus === 'CERTIFICATE_HOLD',
  );
  const unknownEvals = validEvaluations.filter(
    (e) => e.certStatus === 'UNKNOWN',
  );

  // Contradictory authentic evidence: a "not revoked" statement issued at/after a revocation or
  // suspension date. Stale GOOD evidence counts too (it is authentic), except when issued after
  // the certificate expired (the CA may legitimately drop expired entries).
  const authenticGood = [
    ...goodEvals,
    ...notFreshEvaluations.filter(
      (e) => e.thisUpdate && e.thisUpdate <= targetNode.validTo,
    ),
  ];
  const goodIssuedAtOrAfter = (t: Date) =>
    authenticGood.some((gd) => !gd.thisUpdate || gd.thisUpdate >= t);
  let hasContradictoryEvidence =
    revokedEvals.some((rev) => goodIssuedAtOrAfter(rev.revokedAt!)) ||
    holdEvals.some((hold) => goodIssuedAtOrAfter(hold.revokedAt!));
  if (revokedEvals.length > 1) {
    const firstRevTime = revokedEvals[0].revokedAt?.getTime();
    const firstReason = revokedEvals[0].reasonCode;
    if (
      revokedEvals.some(
        (r) =>
          r.revokedAt?.getTime() !== firstRevTime ||
          (r.reasonCode !== undefined &&
            firstReason !== undefined &&
            r.reasonCode !== firstReason),
      )
    ) {
      hasContradictoryEvidence = true;
    }
  }

  return {
    goodEvals,
    revokedEvals,
    holdEvals,
    unknownEvals,
    hasContradictoryEvidence,
  };
}

/**
 * Monta a pergunta "a prova de existência (POE) confiável mostra que a assinatura já existia
 * antes do instante `t`?", com a margem de tolerância da política de frescor.
 */
function makePoeProvesBefore(params: {
  freshness: RevocationFreshnessContext;
  hasTrustedCompletePoe: boolean;
  poeTime: Date | undefined;
}): (t: Date) => boolean {
  const { freshness, hasTrustedCompletePoe, poeTime } = params;
  const graceMs = freshness.gracePeriodMs;
  const poeProvesBefore = (t: Date): boolean =>
    hasTrustedCompletePoe &&
    poeTime !== undefined &&
    poeTime.getTime() + graceMs < t.getTime();
  return poeProvesBefore;
}

/**
 * Certificado revogado em definitivo: decide se a revogação atinge a assinatura, se a POE prova
 * que a assinatura é anterior à revogação ou se a ordem dos fatos não fica provada. Devolve
 * `null` quando não há evidência de revogação.
 */
function summaryForRevokedCertificate(params: {
  base: SummaryBase;
  targetNode: ParsedX509Node;
  role: CertificateRevocationCheckSummary['role'];
  isCaRole: boolean;
  isTsaRole: boolean;
  groups: EvidenceGroups;
  byStatus: EvidenceByStatus;
  poeProvesBefore: (t: Date) => boolean;
  poeTime: Date | undefined;
  validationContext: 'VERIFICATION' | 'LIVE_ISSUANCE';
  referenceTime: Date;
  verificationTime: Date;
}): CertificateRevocationResult | null {
  const {
    base,
    targetNode,
    role,
    isCaRole,
    isTsaRole,
    poeProvesBefore,
    poeTime,
    validationContext,
    referenceTime,
    verificationTime,
  } = params;
  const { source, invalidEvaluations } = params.groups;
  const { revokedEvals, hasContradictoryEvidence } = params.byStatus;

  // Priority 1: Permanent revocation (`REVOKED`)
  if (revokedEvals.length > 0) {
    // Earliest effective revocation instant among authentic revocation evidences.
    const primaryRev = [...revokedEvals].sort(
      (a, b) =>
        effectiveRevocationTime(a.revokedAt!, a.invalidityDate).getTime() -
          effectiveRevocationTime(b.revokedAt!, b.invalidityDate).getTime() ||
        a.revokedAt!.getTime() - b.revokedAt!.getTime() ||
        (a.reasonCode ?? -1) - (b.reasonCode ?? -1),
    )[0];
    const revokedAt = primaryRev.revokedAt!;
    const invalidityDate = primaryRev.invalidityDate;
    const reasonCode = primaryRev.reasonCode;
    const reasonName = primaryRev.reasonName;
    // RFC 5280 §5.3.2: invalidityDate, when present, is the date the certificate became invalid,
    // whatever the reason. The effective instant is the earliest of the two dates.
    const effectiveAt = effectiveRevocationTime(revokedAt, invalidityDate);
    const isKeyCompromise =
      reasonCode === 1 || reasonCode === 2 || reasonCode === 10;
    const conservativeReason = requiresConservativeRevocationTime(reasonCode);
    const revFields = {
      source,
      thisUpdate: primaryRev.thisUpdate,
      nextUpdate: primaryRev.nextUpdate,
      producedAt: primaryRev.producedAt,
      revokedAt,
      invalidityDate,
      reasonCode,
      reasonName,
      isHold: false,
      isKeyCompromise,
    };

    // Positive proof that the signature was created AT/AFTER revocationDate. Only:
    // - LIVE_ISSUANCE: the signature is being produced now (verificationTime) and authentic evidence
    //   shows the certificate was already revoked at or before verificationTime; or
    // - revokedAt <= notBefore: no valid signing instant ever existed for this certificate.
    // `revokedAt <= poeTime` is NEVER proof, since a POE only bounds creation from above.
    const provenSignedAfterRevocation =
      (validationContext === 'LIVE_ISSUANCE' &&
        effectiveAt <= verificationTime) ||
      revokedAt <= targetNode.validFrom;

    if (hasContradictoryEvidence) {
      if (provenSignedAfterRevocation && !isTsaRole) {
        return {
          summary: {
            ...base,
            ...revFields,
            status: 'REVOKED_BEFORE_POE',
            hasContradictoryEvidence: true,
            subIndication: isCaRole
              ? 'REVOKED_CA_BEFORE_POE'
              : 'REVOKED_BEFORE_POE',
            error: `Evidências contraditórias, mas com revogação comprovada anterior à assinatura em "${targetNode.commonName}".`,
          },
          rejectedCount: invalidEvaluations.length,
        };
      }
      return {
        summary: {
          ...base,
          ...revFields,
          status: 'REVOKED_NO_POE',
          hasContradictoryEvidence: true,
          subIndication: 'CONTRADICTORY_REVOCATION_EVIDENCE',
          error: `Evidências de revogação contraditórias para "${targetNode.commonName}" (conflito entre estado GOOD e REVOKED).`,
        },
        rejectedCount: invalidEvaluations.length,
      };
    }

    // TSA certificates: genTime is self-declared by the TSA; without a POE over the timestamp
    // token itself, any revocation of the TSA chain removes its trust (policy, see report A9).
    if (isTsaRole) {
      return {
        summary: {
          ...base,
          ...revFields,
          status:
            effectiveAt <= referenceTime ? 'REVOKED_BEFORE_POE' : 'REVOKED_NO_POE',
          subIndication: role === 'TSA_CA' ? 'TSA_CA_REVOKED' : 'TSA_REVOKED',
          error: `Certificado da cadeia da TSA ("${targetNode.commonName}") encontra-se revogado desde ${revokedAt.toISOString()}.`,
        },
        rejectedCount: invalidEvaluations.length,
      };
    }

    if (provenSignedAfterRevocation) {
      return {
        summary: {
          ...base,
          ...revFields,
          status: 'REVOKED_BEFORE_POE',
          subIndication: isCaRole
            ? 'REVOKED_CA_BEFORE_POE'
            : 'REVOKED_BEFORE_POE',
          error: `Prova suficiente de que a assinatura foi realizada após a revogação de "${targetNode.commonName}" (${effectiveAt.toISOString()}).`,
        },
        rejectedCount: invalidEvaluations.length,
      };
    }

    // A trusted, complete POE proves `t_sig <= poeTime`; it suffices when
    // `poeTime (+ grace) < effective revocation instant`.
    if (poeProvesBefore(effectiveAt)) {
      // keyCompromise / cACompromise / aACompromise / unrecognized reasons: the compromise may
      // predate the administrative revocationDate. Only an explicit invalidityDate (already folded
      // into effectiveAt) bounds it; without it the order stays unproven.
      if (conservativeReason && !invalidityDate) {
        return {
          summary: {
            ...base,
            ...revFields,
            status: 'REVOKED_NO_POE',
            subIndication: 'REVOKED_KEY_COMPROMISE',
            error: `Certificado "${targetNode.commonName}" revogado por comprometimento de chave (${reasonName ?? 'motivo não reconhecido'}) sem invalidityDate que comprove que a assinatura antecede o comprometimento.`,
          },
          rejectedCount: invalidEvaluations.length,
        };
      }
      return {
        summary: { ...base, ...revFields, status: 'GOOD_AT_POE' },
        rejectedCount: invalidEvaluations.length,
      };
    }

    // Otherwise (no trusted POE, or effective revocation <= poeTime): order of events between
    // signature creation and revocation is NOT proven -> INDETERMINATE.
    return {
      summary: {
        ...base,
        ...revFields,
        status: 'REVOKED_NO_POE',
        subIndication: isCaRole ? 'REVOKED_CA_NO_POE' : 'REVOKED_NO_POE',
        error: poeTime
          ? `Certificado "${targetNode.commonName}" revogado com efeito em ${effectiveAt.toISOString()} (<= poeTime ${poeTime.toISOString()}); como a POE comprova apenas que a assinatura existia até poeTime e não o instante exato de sua criação, a ordem temporal permanece INDETERMINATE.`
          : `Certificado "${targetNode.commonName}" revogado com efeito em ${effectiveAt.toISOString()} sem Prova de Existência (POE) confiável anterior à revogação.`,
      },
      rejectedCount: invalidEvaluations.length,
    };
  }
  return null;
}

/**
 * Certificado suspenso (certificateHold): sem POE anterior à suspensão, o resultado fica
 * indeterminado. Devolve `null` quando não há evidência de suspensão.
 */
function summaryForCertificateOnHold(params: {
  base: SummaryBase;
  targetNode: ParsedX509Node;
  isTsaRole: boolean;
  groups: EvidenceGroups;
  byStatus: EvidenceByStatus;
  poeProvesBefore: (t: Date) => boolean;
}): CertificateRevocationResult | null {
  const { base, targetNode, isTsaRole, poeProvesBefore } = params;
  const { source, invalidEvaluations } = params.groups;
  const { holdEvals, hasContradictoryEvidence } = params.byStatus;

  // Priority 2: Certificate Suspension (`CERTIFICATE_HOLD`, reasonCode === 6)
  if (holdEvals.length > 0) {
    const primaryHold = [...holdEvals].sort(
      (a, b) =>
        effectiveRevocationTime(a.revokedAt!, a.invalidityDate).getTime() -
        effectiveRevocationTime(b.revokedAt!, b.invalidityDate).getTime(),
    )[0];
    const holdAt = primaryHold.revokedAt!;
    const holdEffective = effectiveRevocationTime(
      holdAt,
      primaryHold.invalidityDate,
    );
    const holdFields = {
      source,
      thisUpdate: primaryHold.thisUpdate,
      nextUpdate: primaryHold.nextUpdate,
      producedAt: primaryHold.producedAt,
      revokedAt: holdAt,
      invalidityDate: primaryHold.invalidityDate,
      reasonCode: 6,
      reasonName: 'certificateHold' as const,
      isHold: true,
      isKeyCompromise: false,
    };

    if (hasContradictoryEvidence) {
      return {
        summary: {
          ...base,
          ...holdFields,
          status: 'CERTIFICATE_HOLD',
          hasContradictoryEvidence: true,
          subIndication: 'CONTRADICTORY_REVOCATION_EVIDENCE',
          error: `Evidências contraditórias entre suspensão (certificateHold) e estado GOOD para "${targetNode.commonName}".`,
        },
        rejectedCount: invalidEvaluations.length,
      };
    }

    if (poeProvesBefore(holdEffective) && !isTsaRole) {
      return {
        summary: { ...base, ...holdFields, status: 'GOOD_AT_POE' },
        rejectedCount: invalidEvaluations.length,
      };
    }

    // Per ETSI EN 319 102-1 §5.2.5.4: a certificate on hold without prior POE yields INDETERMINATE / TRY_LATER
    return {
      summary: {
        ...base,
        ...holdFields,
        status: 'CERTIFICATE_HOLD',
        subIndication: 'TRY_LATER',
        error: `Certificado "${targetNode.commonName}" encontra-se suspenso (certificateHold) desde ${holdAt.toISOString()}; validação retorna INDETERMINATE (TRY_LATER).`,
      },
      rejectedCount: invalidEvaluations.length,
    };
  }
  return null;
}

/**
 * Sem revogação nem suspensão: se nenhuma evidência diz "bom", o estado é desconhecido; senão
 * vale a evidência "bom" mais recente.
 */
function summaryForGoodOrUnknown(params: {
  base: SummaryBase;
  targetNode: ParsedX509Node;
  groups: EvidenceGroups;
  byStatus: EvidenceByStatus;
  freshness: RevocationFreshnessContext;
}): CertificateRevocationResult {
  const { base, targetNode, freshness } = params;
  const { source, invalidEvaluations } = params.groups;
  const { goodEvals, unknownEvals } = params.byStatus;

  // Priority 3: Only UNKNOWN evaluations (and no GOOD evaluation)
  if (goodEvals.length === 0) {
    const firstUnknown = unknownEvals[0];
    return {
      summary: {
        ...base,
        status: 'INDETERMINATE',
        source,
        thisUpdate: firstUnknown?.thisUpdate,
        nextUpdate: firstUnknown?.nextUpdate,
        producedAt: firstUnknown?.producedAt,
        subIndication: 'OCSP_STATUS_UNKNOWN',
        error:
          firstUnknown?.error ||
          `Estado de revogação desconhecido (OCSP unknown) para "${targetNode.commonName}".`,
      },
      rejectedCount: invalidEvaluations.length,
    };
  }

  // Fresh, authentic GOOD evidence (UNKNOWN from another source does not override it).
  const bestGood = goodEvals.reduce((a, b) =>
    (b.thisUpdate?.getTime() ?? 0) > (a.thisUpdate?.getTime() ?? 0) ? b : a,
  );
  return {
    summary: {
      ...base,
      status: freshness.mode === 'HISTORICAL' ? 'GOOD_AT_POE' : 'GOOD',
      source,
      thisUpdate: bestGood.thisUpdate,
      nextUpdate: bestGood.nextUpdate,
      producedAt: bestGood.producedAt,
    },
    rejectedCount: invalidEvaluations.length,
  };
}

const EVALUATION_KIND_ORDER: Record<SingleEvidenceEvaluation['matchKind'], number> = {
  MATCHED_VALID: 0,
  NOT_FRESH: 1,
  INVALID_EVIDENCE: 2,
  SCOPE_INCOMPATIBLE: 3,
  UNAVAILABLE: 4,
  UNRELATED_ISSUER: 5,
};

/** Ordem total e estável, independente da ordem em que as evidências foram fornecidas. */
function compareEvaluations(
  a: SingleEvidenceEvaluation,
  b: SingleEvidenceEvaluation,
): number {
  const key = (e: SingleEvidenceEvaluation) =>
    [
      String(EVALUATION_KIND_ORDER[e.matchKind]),
      e.source,
      e.certStatus ?? '',
      e.thisUpdate?.toISOString() ?? '',
      e.revokedAt?.toISOString() ?? '',
      e.invalidityDate?.toISOString() ?? '',
      String(e.reasonCode ?? ''),
      e.producedAt?.toISOString() ?? '',
      e.subIndication ?? '',
      e.error ?? '',
    ].join('|');
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
