// Validação de LCR (lista de certificados revogados, RFC 5280): analisa a lista e decide o que
// ela prova sobre um certificado no instante de referência.

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { type ParsedX509Node } from './icp-chain.ts';
import {
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_DELTA_CRL_INDICATOR,
  OID_ISSUING_DISTRIBUTION_POINT,
  ALLOWED_SIGNATURE_OIDS,
  RECOGNIZED_CRL_CRITICAL_EXT_OIDS,
  RECOGNIZED_CRL_ENTRY_CRITICAL_EXT_OIDS,
} from './revocation-oids.ts';
import {
  toDerBufferFromRevocationInput,
  serialNumbersEqual,
  parseAkiKeyIdHex,
  parseIssuingDistributionPointExt,
  extractCertCrlDistributionPointUris,
  parseEntryReasonAndInvalidity,
} from './revocation-asn1.ts';
import {
  type RevocationFreshnessContext,
  goodEvidenceFreshnessProblem,
} from './revocation-freshness.ts';
import type { SingleEvidenceEvaluation } from './revocation-evaluation.ts';

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine already initialized
}

/**
 * Validates a single CRL (RFC 5280) against a target certificate (`targetNode`) and its verified
 * issuer CA (`issuerNode`) at `referenceTime` / `verificationTime`.
 */
/**
 * Limite de elementos ASN.1 ao analisar uma LCR (6F.2D). O padrão do asn1js (10 000) recusa LCRs
 * reais: a da AC Soluti Múltipla v5 (919 KB, 34 mil revogados) tem cerca de 102 mil elementos e
 * ocupa ~146 MB de heap durante a análise. 500 mil cobre LCRs de até ~4 MB e limita a memória
 * mesmo com entrada maliciosa (o tamanho em bytes, sozinho, não limita o número de elementos).
 */
export const CRL_MAX_ASN1_NODES = 500_000;

const crlParseCache = new WeakMap<
  object,
  { crl: pkijs.CertificateRevocationList } | { error: string }
>();

/** Analisa uma LCR DER com limites explícitos; o erro diz a causa. */
export function parseCrlDer(
  der: Buffer,
  cacheKey?: object,
): { crl: pkijs.CertificateRevocationList } | { error: string } {
  const cached = cacheKey ? crlParseCache.get(cacheKey) : undefined;
  if (cached) return cached;
  let result: { crl: pkijs.CertificateRevocationList } | { error: string };
  const asn1 = asn1js.fromBER(
    der.buffer.slice(
      der.byteOffset,
      der.byteOffset + der.byteLength,
    ) as ArrayBuffer,
    { maxNodes: CRL_MAX_ASN1_NODES },
  );
  if (!asn1.result || asn1.offset === -1 || asn1.offset !== der.length) {
    const reason = asn1.result?.error || '';
    result = {
      error: /node count/i.test(reason)
        ? `LCR com mais de ${CRL_MAX_ASN1_NODES} elementos ASN.1 (limite de análise).`
        : `Falha ao decodificar estrutura ASN.1 DER da CRL X.509${reason ? ` (${reason})` : ''}.`,
    };
  } else {
    try {
      result = {
        crl: new pkijs.CertificateRevocationList({ schema: asn1.result }),
      };
    } catch (err) {
      result = {
        error: `Estrutura CertificateList X.509 inválida: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  if (cacheKey) crlParseCache.set(cacheKey, result);
  return result;
}

export async function evaluateCrlForCertificate(params: {
  rawCrl: Buffer | Uint8Array | string;
  targetNode: ParsedX509Node;
  issuerNode: ParsedX509Node;
  referenceTime: Date;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): Promise<SingleEvidenceEvaluation> {
  const {
    rawCrl,
    targetNode,
    issuerNode,
    referenceTime,
    verificationTime,
    freshness,
  } = params;

  let der: Buffer;
  try {
    der = toDerBufferFromRevocationInput(rawCrl);
  } catch (err) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        err instanceof Error
          ? err.message
          : 'Formato de CRL inválido ou corrompido.',
    };
  }

  // A mesma LCR é avaliada contra cada certificado da cadeia; analisa uma vez só.
  const parsed = parseCrlDer(der, typeof rawCrl === 'string' ? undefined : rawCrl);
  if ('error' in parsed) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: parsed.error,
    };
  }
  const crl = parsed.crl;

  // Check if CRL issuer DN matches target certificate's issuer CA DN
  const issuerMatches =
    crl.issuer.isEqual(issuerNode.pkiCert.subject) &&
    targetNode.pkiCert.issuer.isEqual(issuerNode.pkiCert.subject);

  if (!issuerMatches) {
    return {
      source: 'CRL',
      matchKind: 'UNRELATED_ISSUER',
      subIndication: 'CRL_ISSUER_MISMATCH',
      error: `O emissor da CRL não corresponde à Autoridade Certificadora emissora de "${targetNode.commonName}".`,
    };
  }

  // RFC 5280 §5.1.1.2 & §5.1.2.2: outer signatureAlgorithm MUST equal inner tbsCertList.signature
  const outerAlgOid = crl.signatureAlgorithm?.algorithmId || '';
  const innerAlgOid = crl.signature?.algorithmId || '';
  if (!outerAlgOid || outerAlgOid !== innerAlgOid) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Divergência entre signatureAlgorithm externo (${outerAlgOid}) e tbsCertList.signature (${innerAlgOid}) na CRL.`,
    };
  }

  const allowedSigAlg = ALLOWED_SIGNATURE_OIDS[outerAlgOid];
  if (!allowedSigAlg) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Algoritmo de assinatura da CRL não suportado ou inseguro (${outerAlgOid}).`,
    };
  }

  // Check issuer CA authorization: must be a CA and have KeyUsage.cRLSign = true
  if (
    !issuerNode.basicConstraints.present ||
    !issuerNode.basicConstraints.cA ||
    issuerNode.basicConstraints.malformed
  ) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Emissor da CRL "${issuerNode.commonName}" não é uma Autoridade Certificadora válida (BasicConstraints cA=false).`,
    };
  }

  if (
    !issuerNode.keyUsage.present ||
    !issuerNode.keyUsage.cRLSign ||
    issuerNode.keyUsage.malformed
  ) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Autoridade emissora "${issuerNode.commonName}" não possui permissão KeyUsage.cRLSign para assinar CRLs.`,
    };
  }

  // Check CRL AuthorityKeyIdentifier (if present) against issuerNode SubjectKeyIdentifier
  const crlExtensions = crl.crlExtensions?.extensions || [];
  const akiExt = crlExtensions.find(
    (e) => e.extnID === OID_AUTHORITY_KEY_IDENTIFIER,
  );
  const crlAkiHex = parseAkiKeyIdHex(akiExt);
  if (
    crlAkiHex &&
    issuerNode.skiHex &&
    crlAkiHex !== issuerNode.skiHex.toLowerCase()
  ) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `AuthorityKeyIdentifier da CRL (${crlAkiHex}) diverge do SubjectKeyIdentifier da AC emissora "${issuerNode.commonName}".`,
    };
  }

  // Verify cryptographic signature of CRL using issuerNode's public key
  let signatureValid = false;
  try {
    signatureValid = Boolean(
      await crl.verify({ issuerCertificate: issuerNode.pkiCert }),
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Assinatura criptográfica da CRL inválida perante a chave pública da AC "${issuerNode.commonName}".`,
    };
  }

  // Check CRL version & extensions (RFC 5280 §5.2)
  for (const ext of crlExtensions) {
    if (ext.critical && !RECOGNIZED_CRL_CRITICAL_EXT_OIDS.has(ext.extnID)) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_UNRECOGNIZED_CRITICAL_EXTENSION',
        error: `CRL contém extensão crítica não reconhecida (${ext.extnID}).`,
      };
    }
  }

  // Policy restriction 1: Reject standalone Delta CRLs (OID 2.5.29.27)
  const deltaExt = crlExtensions.find(
    (e) => e.extnID === OID_DELTA_CRL_INDICATOR,
  );
  if (deltaExt) {
    return {
      source: 'CRL',
      matchKind: 'SCOPE_INCOMPATIBLE',
      subIndication: 'CRL_DELTA_UNSUPPORTED',
      error:
        'CRL Delta isolada (DeltaCRLIndicator 2.5.29.27) não constitui prova completa de ausência de revogação.',
    };
  }

  // Policy restriction 2: IssuingDistributionPoint (OID 2.5.29.28) — indirect, partitioned, or partial CRLs
  const idpExt = crlExtensions.find(
    (e) => e.extnID === OID_ISSUING_DISTRIBUTION_POINT,
  );
  const idp = parseIssuingDistributionPointExt(idpExt);
  if (idp.malformed) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Extensão IssuingDistributionPoint (2.5.29.28) da CRL malformada.',
    };
  }

  if (idp.present) {
    if (idp.indirectCRL) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_INDIRECT_UNSUPPORTED',
        error:
          'CRL indireta (IssuingDistributionPoint.indirectCRL = true) não é suportada pela política de revogação.',
      };
    }

    if (idp.onlyContainsAttributeCerts) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_SCOPE_INCOMPATIBLE',
        error:
          'CRL restrita a certificados de atributo (onlyContainsAttributeCerts = true) não se aplica a certificados X.509.',
      };
    }

    if (idp.onlyContainsCACerts && !targetNode.basicConstraints.cA) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_SCOPE_INCOMPATIBLE',
        error: `CRL restrita a certificados de AC (onlyContainsCACerts = true) é incompatível com o certificado final "${targetNode.commonName}".`,
      };
    }

    if (idp.onlyContainsUserCerts && targetNode.basicConstraints.cA) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_SCOPE_INCOMPATIBLE',
        error: `CRL restrita a certificados de usuário final (onlyContainsUserCerts = true) é incompatível com a AC "${targetNode.commonName}".`,
      };
    }

    if (idp.onlySomeReasonsPresent) {
      return {
        source: 'CRL',
        matchKind: 'SCOPE_INCOMPATIBLE',
        subIndication: 'CRL_PARTIAL_SCOPE',
        error:
          'CRL parcial particionada por motivos (onlySomeReasons) não comprova ausência de revogação para os demais motivos.',
      };
    }

    if (idp.hasDistributionPointName) {
      if (idp.hasRelativeName || idp.distributionPointUris.length === 0) {
        return {
          source: 'CRL',
          matchKind: 'SCOPE_INCOMPATIBLE',
          subIndication: 'CRL_SCOPE_INCOMPATIBLE',
          error:
            'CRL particionada por DistributionPoint sem URI compatível verificável no certificado alvo.',
        };
      }
      const certCdp = extractCertCrlDistributionPointUris(targetNode.pkiCert);
      const matchesDpUri = idp.distributionPointUris.some((u) =>
        certCdp.uris.includes(u),
      );
      if (!certCdp.present || !matchesDpUri) {
        return {
          source: 'CRL',
          matchKind: 'SCOPE_INCOMPATIBLE',
          subIndication: 'CRL_SCOPE_INCOMPATIBLE',
          error: `Escopo da CRL particionada (${idp.distributionPointUris.join(', ')}) não corresponde ao CRLDistributionPoints do certificado "${targetNode.commonName}".`,
        };
      }
    }
  }

  // Also check if targetNode itself mandates indirect CRL or reason-partitioned CRLs only
  const targetCdp = extractCertCrlDistributionPointUris(targetNode.pkiCert);
  if (targetCdp.hasIndirectCrlIssuerOnly || targetCdp.hasPartialReasonsOnly) {
    return {
      source: 'CRL',
      matchKind: 'SCOPE_INCOMPATIBLE',
      subIndication: 'CRL_SCOPE_INCOMPATIBLE',
      error: `Certificado "${targetNode.commonName}" exige modalidade de CRL indireta ou particionada não suportada.`,
    };
  }

  // Validate thisUpdate and nextUpdate
  const thisUpdate = crl.thisUpdate?.value;
  const nextUpdate = crl.nextUpdate?.value;
  if (
    !(thisUpdate instanceof Date) ||
    Number.isNaN(thisUpdate.getTime()) ||
    !(nextUpdate instanceof Date) ||
    Number.isNaN(nextUpdate.getTime()) ||
    nextUpdate < thisUpdate
  ) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        'Campos temporais thisUpdate/nextUpdate da CRL ausentes, inválidos ou com período incompatível (nextUpdate < thisUpdate).',
    };
  }

  // CRL must be issued within the issuing CA's own validity period
  if (thisUpdate < issuerNode.validFrom || thisUpdate > issuerNode.validTo) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `A CRL foi emitida fora da janela de vigência da AC "${issuerNode.commonName}".`,
    };
  }

  // CRL cannot come from the future relative to verificationTime
  if (thisUpdate > verificationTime) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `O campo thisUpdate da CRL (${thisUpdate.toISOString()}) é posterior ao instante de verificação (${verificationTime.toISOString()}).`,
    };
  }

  // Search for targetNode.serialNumber in crl.revokedCertificates
  const revokedEntries = crl.revokedCertificates || [];
  const matchingEntry = revokedEntries.find((entry) =>
    serialNumbersEqual(entry.userCertificate, targetNode.pkiCert.serialNumber),
  );

  if (!matchingEntry) {
    // Frescor só se aplica à prova de NÃO revogação (política em RevocationFreshnessContext).
    const problem = goodEvidenceFreshnessProblem({
      thisUpdate,
      nextUpdate,
      referenceTime,
      verificationTime,
      targetValidTo: targetNode.validTo,
      freshness,
    });
    if (problem) {
      return {
        source: 'CRL',
        matchKind: 'NOT_FRESH',
        certStatus: 'GOOD',
        thisUpdate,
        nextUpdate,
        subIndication: 'TRY_LATER',
        error: `CRL autêntica sem frescor suficiente para "${targetNode.commonName}": ${problem}.`,
      };
    }
  }

  if (!matchingEntry) {
    return {
      source: 'CRL',
      matchKind: 'MATCHED_VALID',
      certStatus: 'GOOD',
      thisUpdate,
      nextUpdate,
    };
  }

  // Certificate is present in revokedCertificates
  const revokedAt = matchingEntry.revocationDate?.value;
  if (!(revokedAt instanceof Date) || Number.isNaN(revokedAt.getTime())) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Entrada de revogação na CRL possui revocationDate inválido.',
    };
  }
  if (revokedAt > thisUpdate) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Entrada de revogação com revocationDate posterior ao thisUpdate da própria CRL.',
    };
  }

  const entryExtInfo = parseEntryReasonAndInvalidity(
    matchingEntry.crlEntryExtensions?.extensions,
    RECOGNIZED_CRL_ENTRY_CRITICAL_EXT_OIDS,
  );

  if (entryExtInfo.malformed) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Extensão de entrada de revogação (crlEntryExtensions) malformada na CRL.',
    };
  }

  if (
    entryExtInfo.hasIndirectCertIssuer ||
    entryExtInfo.hasUnrecognizedCriticalExtension
  ) {
    return {
      source: 'CRL',
      matchKind: 'SCOPE_INCOMPATIBLE',
      thisUpdate,
      nextUpdate,
      subIndication: entryExtInfo.hasIndirectCertIssuer
        ? 'CRL_INDIRECT_UNSUPPORTED'
        : 'CRL_UNRECOGNIZED_CRITICAL_EXTENSION',
      error:
        'Entrada de revogação na CRL contém extensão crítica desconhecida ou CertificateIssuer indireto.',
    };
  }

  const isHold = entryExtInfo.reasonCode === 6;

  return {
    source: 'CRL',
    matchKind: 'MATCHED_VALID',
    certStatus: isHold ? 'CERTIFICATE_HOLD' : 'REVOKED',
    thisUpdate,
    nextUpdate,
    revokedAt,
    invalidityDate: entryExtInfo.invalidityDate,
    reasonCode: entryExtInfo.reasonCode,
    reasonName: entryExtInfo.reasonName,
  };
}
