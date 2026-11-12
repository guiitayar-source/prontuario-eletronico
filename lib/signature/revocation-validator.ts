import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import type { ParsedX509Node } from './icp-chain.ts';
import type {
  CertificateRevocationCheckSummary,
  PadesRevocationResult,
  PadesTemporalValidityResult,
  PadesVerificationOptions,
} from './types.ts';
import { toDerBufferFromRevocationInput } from './revocation-asn1.ts';
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

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine already initialized
}

// As partes já separadas moram em arquivos próprios; os nomes públicos seguem disponíveis aqui.
export {
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_ISSUER_ALT_NAME,
  OID_CRL_NUMBER,
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_DELTA_CRL_INDICATOR,
  OID_ISSUING_DISTRIBUTION_POINT,
  OID_CERTIFICATE_ISSUER,
  OID_CRL_DISTRIBUTION_POINTS,
  OID_FRESHEST_CRL,
  OID_AUTHORITY_INFO_ACCESS,
  OID_KP_OCSP_SIGNING,
  OID_PKIX_OCSP_BASIC,
  OID_PKIX_OCSP_NONCE,
  OID_PKIX_OCSP_CRL,
  OID_PKIX_OCSP_RESPONSE,
  OID_PKIX_OCSP_NOCHECK,
  OID_PKIX_OCSP_ARCHIVE_CUTOFF,
} from './revocation-oids.ts';
export {
  mapCrlReasonCodeToName,
  extractCertCrlDistributionPointUris,
} from './revocation-asn1.ts';
export {
  DEFAULT_OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_SECONDS,
  freshnessContextFromOptions,
} from './revocation-freshness.ts';
export type { RevocationFreshnessContext } from './revocation-freshness.ts';
export { CRL_MAX_ASN1_NODES, parseCrlDer, evaluateCrlForCertificate } from './revocation-crl.ts';
export { evaluateOcspForCertificate } from './revocation-ocsp.ts';
export {
  effectiveRevocationTime,
  requiresConservativeRevocationTime,
} from './revocation-evaluation.ts';
export type { SingleEvidenceEvaluation } from './revocation-evaluation.ts';

/**
 * Evaluates revocation status for a single certificate (`targetNode`, issued by `issuerNode`)
 * across all provided CRLs and OCSP responses, applying ETSI EN 319 102-1 temporal POE semantics.
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

  const graceMs = freshness.gracePeriodMs;
  const poeProvesBefore = (t: Date): boolean =>
    hasTrustedCompletePoe &&
    poeTime !== undefined &&
    poeTime.getTime() + graceMs < t.getTime();

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

/**

 * Evaluates revocation across all non-root certificates in a TSA certification chain
 * (`[tsaSignerNode, ...tsaIntermediates, tsaRootAnchor]`) at `genTime` / `verificationTime`.
 *
 * The self-issued Trust Anchor (`tsaRootAnchor`) follows explicit trust anchor policy and is not
 * queried as an ordinary subordinate certificate.
 */
export async function evaluateTsaChainRevocation(params: {
  tsaChainNodes: ParsedX509Node[];
  genTime: Date;
  verificationTime: Date;
  options: PadesVerificationOptions;
}): Promise<{
  revocationChecked: boolean;
  trustComplete: boolean;
  isRevoked: boolean;
  hasInvalidEvidence: boolean;
  certificateResults: CertificateRevocationCheckSummary[];
  subIndication?: string;
  error?: string;
}> {
  const { tsaChainNodes, genTime, verificationTime, options } = params;
  const rawCrls = options.crls || [];
  const rawOcspResponses = options.ocspResponses || [];

  if (rawCrls.length === 0 && rawOcspResponses.length === 0) {
    return {
      revocationChecked: false,
      trustComplete: false,
      isRevoked: false,
      hasInvalidEvidence: false,
      certificateResults: [],
    };
  }

  if (tsaChainNodes.length < 2) {
    return {
      revocationChecked: false,
      trustComplete: false,
      isRevoked: false,
      hasInvalidEvidence: false,
      certificateResults: [],
    };
  }

  const extraResponderCerts: unknown[] = [
    ...(options.ocspResponderCerts || []),
    ...(options.ocspResponderPems || []),
    ...(options.tsaIntermediateCerts || []),
    ...(options.tsaIntermediatePems || []),
    ...(options.intermediateCerts || []),
    ...(options.intermediatePems || []),
    ...tsaChainNodes.map((n) => n.pkiCert),
  ];

  const certificateResults: CertificateRevocationCheckSummary[] = [];
  const visitedCertFingerprints = new Set<string>();

  for (let i = 0; i < tsaChainNodes.length - 1; i += 1) {
    const targetNode = tsaChainNodes[i];
    const issuerNode = tsaChainNodes[i + 1];

    // Guard against circular certificate loops
    if (visitedCertFingerprints.has(targetNode.fingerprint256)) {
      return {
        revocationChecked: true,
        trustComplete: false,
        isRevoked: false,
        hasInvalidEvidence: true,
        certificateResults,
        subIndication: 'TSA_CHAIN_CIRCULAR_DEPENDENCY',
        error: 'Loop circular detectado na verificação de revogação da cadeia da TSA.',
      };
    }
    visitedCertFingerprints.add(targetNode.fingerprint256);

    // Explicit trust anchor policy: do not query a self-issued trust anchor as a subordinate certificate
    if (targetNode.isSelfIssued && i === tsaChainNodes.length - 1) {
      continue;
    }

    const role: 'TSA_SIGNER' | 'TSA_CA' =
      i === 0 ? 'TSA_SIGNER' : 'TSA_CA';

    const { summary } = await evaluateSingleCertificateRevocation({
      targetNode,
      issuerNode,
      role,
      rawCrls,
      rawOcspResponses,
      extraResponderCerts,
      referenceTime: genTime,
      verificationTime,
      hasTrustedCompletePoe: true,
      poeTime: genTime,
      // genTime é a referência histórica da própria TSA: exige evidência emitida depois dele.
      freshness: freshnessContextFromOptions(options, 'HISTORICAL'),
      validationContext: options.validationContext,
    });

    certificateResults.push(summary);
  }

  const revokedItem = certificateResults.find(
    (r) =>
      r.status === 'REVOKED_BEFORE_POE' ||
      r.status === 'REVOKED_NO_POE' ||
      r.status === 'CERTIFICATE_HOLD',
  );
  if (revokedItem) {
    return {
      revocationChecked: true,
      trustComplete: false,
      isRevoked: true,
      hasInvalidEvidence: false,
      certificateResults,
      subIndication:
        revokedItem.subIndication ||
        (revokedItem.role === 'TSA_CA' ? 'TSA_CA_REVOKED' : 'TSA_REVOKED'),
      error: revokedItem.error,
    };
  }

  const invalidItem = certificateResults.find(
    (r) => r.status === 'INVALID_EVIDENCE',
  );
  if (invalidItem) {
    return {
      revocationChecked: true,
      trustComplete: false,
      isRevoked: false,
      hasInvalidEvidence: true,
      certificateResults,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: invalidItem.error,
    };
  }

  const allGood =
    certificateResults.length > 0 &&
    certificateResults.every(
      (r) => r.status === 'GOOD' || r.status === 'GOOD_AT_POE',
    );

  if (allGood) {
    return {
      revocationChecked: true,
      trustComplete: true,
      isRevoked: false,
      hasInvalidEvidence: false,
      certificateResults,
    };
  }

  const missingItem = certificateResults.find(
    (r) => r.status === 'INDETERMINATE',
  );
  const anyChecked = certificateResults.some((r) => r.source !== 'NONE');

  return {
    revocationChecked: anyChecked,
    trustComplete: false,
    isRevoked: false,
    hasInvalidEvidence: false,
    certificateResults,
    subIndication: missingItem?.subIndication || 'TSA_REVOCATION_UNAVAILABLE',
    error: missingItem?.error,
  };
}

/**
 * Evaluates revocation across the entire document signer chain (signer + intermediate CAs)
 * and integrates with TSA revocation and POE temporal semantics (Lote 6F.2C).
 */
export async function evaluateDocumentRevocation(params: {
  signerChainNodes: ParsedX509Node[];
  temporalValidity: PadesTemporalValidityResult;
  claimedSigningTime?: Date;
  verificationTime: Date;
  options: PadesVerificationOptions;
  embeddedCmsCrls?: Array<Buffer | Uint8Array>;
  tsaRevocationSummaries?: CertificateRevocationCheckSummary[];
}): Promise<PadesRevocationResult> {
  const {
    signerChainNodes,
    temporalValidity,
    claimedSigningTime,
    verificationTime,
    options,
    embeddedCmsCrls = [],
    tsaRevocationSummaries = [],
  } = params;

  const sourcePolicy =
    options.revocationEvidenceSourcePolicy ?? 'INJECTED_ONLY';

  const rawCrls: Array<Buffer | Uint8Array | string> = [
    ...(options.crls || []),
    ...(sourcePolicy === 'INJECTED_AND_EMBEDDED_LTV' ? embeddedCmsCrls : []),
  ];
  const rawOcspResponses: Array<Buffer | Uint8Array | string> = [
    ...(options.ocspResponses || []),
  ];

  // If no CRL or OCSP evidence was provided at all:
  if (rawCrls.length === 0 && rawOcspResponses.length === 0) {
    return {
      status: 'INDETERMINATE',
      checked: false,
      source: 'NONE',
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      subIndication: 'REVOCATION_UNAVAILABLE',
    };
  }

  // If chain validation did not even find an issuer for the signer (e.g. self-signed or incomplete chain with length < 2):
  if (signerChainNodes.length < 2) {
    return {
      status: 'INDETERMINATE',
      checked: false,
      source: 'NONE',
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      subIndication: 'REVOCATION_UNAVAILABLE',
      error:
        'Não é possível validar revogação sem o certificado da Autoridade Certificadora emissora na cadeia.',
    };
  }

  // Determine whether the POE is completely trusted (either authenticated External POE, or RFC 3161 with tsaTrustComplete === true)
  const hasTrustedCompletePoe =
    temporalValidity.hasTrustedPoe &&
    Boolean(temporalValidity.poeTime) &&
    (temporalValidity.poeSource === 'EXTERNAL_POE'
      ? temporalValidity.externalPoeValid === true
      : temporalValidity.tsaTrustComplete === true);

  const effectivePoeTime = hasTrustedCompletePoe
    ? temporalValidity.poeTime
    : undefined;
  const referenceTime = effectivePoeTime ?? verificationTime;

  const extraResponderCerts: unknown[] = [
    ...(options.ocspResponderCerts || []),
    ...(options.ocspResponderPems || []),
    ...(options.intermediateCerts || []),
    ...(options.intermediatePems || []),
    ...signerChainNodes.map((n) => n.pkiCert),
  ];

  const signerCertResults: CertificateRevocationCheckSummary[] = [];
  const visitedFingerprints = new Set<string>();
  let totalRejectedCount = 0;

  // Iterate over all non-root certificates in signerChainNodes:
  // index 0 is SIGNER, indices 1..N-2 are SIGNER_CA (intermediate CAs), index N-1 is Root Trust Anchor.
  for (let i = 0; i < signerChainNodes.length - 1; i += 1) {
    const targetNode = signerChainNodes[i];
    const issuerNode = signerChainNodes[i + 1];

    if (visitedFingerprints.has(targetNode.fingerprint256)) {
      return {
        status: 'INVALID_EVIDENCE',
        checked: true,
        source: 'NONE',
        signerChainComplete: false,
        tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: 'Dependência circular detectada na cadeia de certificados durante validação de revogação.',
      };
    }
    visitedFingerprints.add(targetNode.fingerprint256);

    if (targetNode.isSelfIssued && i === signerChainNodes.length - 1) {
      continue;
    }

    const role: 'SIGNER' | 'SIGNER_CA' = i === 0 ? 'SIGNER' : 'SIGNER_CA';

    const { summary, rejectedCount } =
      await evaluateSingleCertificateRevocation({
        targetNode,
        issuerNode,
        role,
        rawCrls,
        rawOcspResponses,
        extraResponderCerts,
        referenceTime,
        verificationTime,
        hasTrustedCompletePoe,
        poeTime: effectivePoeTime,
        freshness: freshnessContextFromOptions(
          options,
          hasTrustedCompletePoe ? 'HISTORICAL' : 'CURRENT',
        ),
        claimedSigningTime,
        validationContext: options.validationContext,
      });

    signerCertResults.push(summary);
    totalRejectedCount += rejectedCount;
  }

  const allCertResults: CertificateRevocationCheckSummary[] = [
    ...signerCertResults,
    ...tsaRevocationSummaries,
  ];

  const usedCrl = allCertResults.some(
    (r) => r.source === 'CRL' || r.source === 'BOTH',
  );
  const usedOcsp = allCertResults.some(
    (r) => r.source === 'OCSP' || r.source === 'BOTH',
  );
  const combinedSource: 'CRL' | 'OCSP' | 'BOTH' | 'NONE' =
    usedCrl && usedOcsp
      ? 'BOTH'
      : usedCrl
        ? 'CRL'
        : usedOcsp
          ? 'OCSP'
          : 'NONE';

  const hasContradictoryEvidence = allCertResults.some(
    (r) => r.hasContradictoryEvidence === true,
  );

  // 1. Check if any signer or intermediate CA certificate was proven REVOKED_BEFORE_POE (signature performed at/after revocation)
  const hardRevokedSignerItem = signerCertResults.find(
    (r) => r.status === 'REVOKED_BEFORE_POE',
  );
  if (hardRevokedSignerItem) {
    return {
      status: 'REVOKED_BEFORE_POE',
      checked: true,
      source: combinedSource,
      revokedAt: hardRevokedSignerItem.revokedAt,
      invalidityDate: hardRevokedSignerItem.invalidityDate,
      reasonCode: hardRevokedSignerItem.reasonCode,
      reasonName: hardRevokedSignerItem.reasonName,
      isHold: Boolean(hardRevokedSignerItem.isHold),
      isKeyCompromise: Boolean(hardRevokedSignerItem.isKeyCompromise),
      revokedCertificateRole: hardRevokedSignerItem.role,
      revokedCertificateSubject: hardRevokedSignerItem.subject,
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      hasContradictoryEvidence,
      rejectedEvidencesCount: totalRejectedCount,
      certificateResults: allCertResults,
      subIndication:
        hardRevokedSignerItem.subIndication ||
        (hardRevokedSignerItem.role === 'SIGNER_CA'
          ? 'REVOKED_CA_BEFORE_POE'
          : 'REVOKED_BEFORE_POE'),
      error: hardRevokedSignerItem.error,
    };
  }

  // 2. Check if any signer or intermediate CA certificate is REVOKED_NO_POE or CERTIFICATE_HOLD
  const softRevokedSignerItem = signerCertResults.find(
    (r) => r.status === 'REVOKED_NO_POE' || r.status === 'CERTIFICATE_HOLD',
  );
  if (softRevokedSignerItem) {
    return {
      status:
        softRevokedSignerItem.status === 'CERTIFICATE_HOLD'
          ? 'INDETERMINATE'
          : 'REVOKED_NO_POE',
      checked: true,
      source: combinedSource,
      revokedAt: softRevokedSignerItem.revokedAt,
      invalidityDate: softRevokedSignerItem.invalidityDate,
      reasonCode: softRevokedSignerItem.reasonCode,
      reasonName: softRevokedSignerItem.reasonName,
      isHold: Boolean(softRevokedSignerItem.isHold),
      isKeyCompromise: Boolean(softRevokedSignerItem.isKeyCompromise),
      revokedCertificateRole: softRevokedSignerItem.role,
      revokedCertificateSubject: softRevokedSignerItem.subject,
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      hasContradictoryEvidence,
      rejectedEvidencesCount: totalRejectedCount,
      certificateResults: allCertResults,
      subIndication:
        softRevokedSignerItem.subIndication ||
        (softRevokedSignerItem.isHold
          ? 'TRY_LATER'
          : softRevokedSignerItem.role === 'SIGNER_CA'
            ? 'REVOKED_CA_NO_POE'
            : 'REVOKED_NO_POE'),
      error: softRevokedSignerItem.error,
    };
  }

  // 3. Check if any TSA certificate was revoked
  const revokedTsaItem = tsaRevocationSummaries.find(
    (r) =>
      r.status === 'REVOKED_BEFORE_POE' ||
      r.status === 'REVOKED_NO_POE' ||
      r.status === 'CERTIFICATE_HOLD',
  );
  if (revokedTsaItem) {
    return {
      status: 'INDETERMINATE',
      checked: true,
      source: combinedSource,
      revokedAt: revokedTsaItem.revokedAt,
      invalidityDate: revokedTsaItem.invalidityDate,
      reasonCode: revokedTsaItem.reasonCode,
      reasonName: revokedTsaItem.reasonName,
      isHold: Boolean(revokedTsaItem.isHold),
      isKeyCompromise: Boolean(revokedTsaItem.isKeyCompromise),
      revokedCertificateRole: revokedTsaItem.role,
      revokedCertificateSubject: revokedTsaItem.subject,
      signerChainComplete: signerCertResults.every(
        (r) => r.status === 'GOOD' || r.status === 'GOOD_AT_POE',
      ),
      tsaChainComplete: false,
      hasContradictoryEvidence,
      rejectedEvidencesCount: totalRejectedCount,
      certificateResults: allCertResults,
      subIndication: revokedTsaItem.subIndication || 'TSA_REVOKED',
      error: revokedTsaItem.error,
    };
  }

  // 4. Check if any certificate in the signer chain or TSA chain had INVALID_EVIDENCE (and no valid backup evidence)
  const invalidEvidenceItem = allCertResults.find(
    (r) => r.status === 'INVALID_EVIDENCE',
  );
  if (invalidEvidenceItem) {
    return {
      status: 'INVALID_EVIDENCE',
      checked: true,
      source: combinedSource,
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      hasContradictoryEvidence,
      rejectedEvidencesCount: Math.max(1, totalRejectedCount),
      certificateResults: allCertResults,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: invalidEvidenceItem.error,
    };
  }

  // 5. Check if all certificates in the signer chain are proven GOOD or GOOD_AT_POE
  const signerChainComplete =
    signerCertResults.length > 0 &&
    signerCertResults.every(
      (r) => r.status === 'GOOD' || r.status === 'GOOD_AT_POE',
    );

  if (!signerChainComplete) {
    const indeterminateItem = signerCertResults.find(
      (r) => r.status === 'INDETERMINATE',
    );
    // Also check if all provided CRLs/OCSPs were completely unrelated or malformed
    let unparseableOrUnrelatedError: string | undefined;
    let hadCorruptedInput = false;
    for (const rawCrl of rawCrls) {
      try {
        const der = toDerBufferFromRevocationInput(rawCrl);
        const asn1 = asn1js.fromBER(
          der.buffer.slice(
            der.byteOffset,
            der.byteOffset + der.byteLength,
          ) as ArrayBuffer,
        );
        if (!asn1.result || asn1.offset === -1 || asn1.offset !== der.length) {
          hadCorruptedInput = true;
          unparseableOrUnrelatedError =
            'CRL fornecida possui estrutura ASN.1 inválida.';
        } else {
          new pkijs.CertificateRevocationList({ schema: asn1.result });
        }
      } catch (e) {
        hadCorruptedInput = true;
        unparseableOrUnrelatedError =
          e instanceof Error ? e.message : 'CRL inválida.';
      }
    }
    for (const rawOcsp of rawOcspResponses) {
      try {
        const der = toDerBufferFromRevocationInput(rawOcsp);
        const asn1 = asn1js.fromBER(
          der.buffer.slice(
            der.byteOffset,
            der.byteOffset + der.byteLength,
          ) as ArrayBuffer,
        );
        if (!asn1.result || asn1.offset === -1 || asn1.offset !== der.length) {
          hadCorruptedInput = true;
          unparseableOrUnrelatedError =
            'Resposta OCSP fornecida possui estrutura ASN.1 inválida.';
        } else {
          new pkijs.OCSPResponse({ schema: asn1.result });
        }
      } catch (e) {
        hadCorruptedInput = true;
        unparseableOrUnrelatedError =
          e instanceof Error ? e.message : 'Resposta OCSP inválida.';
      }
    }

    if (hadCorruptedInput) {
      return {
        status: 'INVALID_EVIDENCE',
        checked: true,
        source: combinedSource,
        signerChainComplete: false,
        tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
        hasContradictoryEvidence,
        rejectedEvidencesCount: Math.max(1, totalRejectedCount),
        certificateResults: allCertResults,
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: unparseableOrUnrelatedError,
      };
    }

    return {
      status: 'INDETERMINATE',
      checked: true,
      source: combinedSource,
      signerChainComplete: false,
      tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
      hasContradictoryEvidence,
      rejectedEvidencesCount: totalRejectedCount,
      certificateResults: allCertResults,
      subIndication:
        indeterminateItem?.subIndication || 'REVOCATION_UNAVAILABLE',
      error: indeterminateItem?.error,
    };
  }

  // 6. All certificates in signerChainNodes are GOOD or GOOD_AT_POE!
  return {
    status: hasTrustedCompletePoe ? 'GOOD_AT_POE' : 'GOOD',
    checked: true,
    source: combinedSource,
    signerChainComplete: true,
    tsaChainComplete: temporalValidity.tsaTrustComplete ?? false,
    hasContradictoryEvidence,
    rejectedEvidencesCount: totalRejectedCount,
    certificateResults: allCertResults,
  };
}
