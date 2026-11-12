// Validação de revogação (LCR e OCSP) das assinaturas PAdES — ponto de entrada.
//
// Aqui ficam só as duas avaliações de cadeia: a do carimbo de tempo (`evaluateTsaChainRevocation`)
// e a do documento (`evaluateDocumentRevocation`). O restante está em arquivos por assunto:
//   revocation-oids.ts         constantes (OIDs, algoritmos e extensões aceitos)
//   revocation-asn1.ts         leitura das estruturas do certificado e da LCR
//   revocation-freshness.ts    quando uma evidência de "não revogado" ainda vale
//   revocation-evaluation.ts   formato do resultado e instante em que a revogação vale
//   revocation-crl.ts          validação de uma LCR
//   revocation-ocsp.ts         validação de uma resposta OCSP
//   revocation-certificate.ts  decisão sobre UM certificado, juntando LCRs e OCSPs
// Quem importa deste arquivo continua encontrando os mesmos nomes (reexportados abaixo).

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
import { freshnessContextFromOptions } from './revocation-freshness.ts';
import { evaluateSingleCertificateRevocation } from './revocation-certificate.ts';

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
export { evaluateSingleCertificateRevocation } from './revocation-certificate.ts';

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
