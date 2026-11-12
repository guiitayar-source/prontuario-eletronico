// Validação de resposta OCSP (RFC 6960): confere quem assinou a resposta, se o respondente
// delegado está autorizado e não revogado, e o que a resposta prova sobre um certificado.

import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { parseX509Node, type ParsedX509Node } from './icp-chain.ts';
import {
  OID_KP_OCSP_SIGNING,
  OID_PKIX_OCSP_BASIC,
  OID_PKIX_OCSP_NOCHECK,
  ALLOWED_SIGNATURE_OIDS,
  ALLOWED_CERTID_HASH_OIDS,
  RECOGNIZED_OCSP_RESPONSE_CRITICAL_EXT_OIDS,
  RECOGNIZED_OCSP_SINGLE_CRITICAL_EXT_OIDS,
} from './revocation-oids.ts';
import {
  mapCrlReasonCodeToName,
  toDerBufferFromRevocationInput,
  serialNumbersEqual,
  parseEntryReasonAndInvalidity,
} from './revocation-asn1.ts';
import {
  type RevocationFreshnessContext,
  goodEvidenceFreshnessProblem,
} from './revocation-freshness.ts';
import { evaluateCrlForCertificate } from './revocation-crl.ts';
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

/**
 * Determines the revocation status of a delegated OCSP responder certificate using only authentic
 * CRLs from `issuerNode` (no nested OCSP lookups, avoiding circular dependencies).
 */
async function ocspResponderStatusFromCrls(params: {
  responderNode: ParsedX509Node;
  issuerNode: ParsedX509Node;
  rawCrls: Array<Buffer | Uint8Array | string>;
  producedAt: Date;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): Promise<'GOOD' | 'REVOKED' | 'UNKNOWN'> {
  let sawGood = false;
  for (const rawCrl of params.rawCrls) {
    const evalRes = await evaluateCrlForCertificate({
      rawCrl,
      targetNode: params.responderNode,
      issuerNode: params.issuerNode,
      referenceTime: params.producedAt,
      verificationTime: params.verificationTime,
      freshness: { ...params.freshness, mode: 'COVERING_OR_LATER' },
    });
    if (evalRes.matchKind !== 'MATCHED_VALID') continue;
    if (
      (evalRes.certStatus === 'REVOKED' ||
        evalRes.certStatus === 'CERTIFICATE_HOLD') &&
      evalRes.revokedAt &&
      // Chave do respondente comprometida torna qualquer producedAt suspeito (pode ser retroativo).
      (requiresConservativeRevocationTime(evalRes.reasonCode) ||
        effectiveRevocationTime(evalRes.revokedAt, evalRes.invalidityDate) <=
          params.producedAt)
    ) {
      return 'REVOKED';
    }
    if (evalRes.certStatus === 'GOOD') sawGood = true;
  }
  return sawGood ? 'GOOD' : 'UNKNOWN';
}

function hasOcspNoCheckExtension(node: ParsedX509Node): boolean {
  return Boolean(
    node.pkiCert.extensions?.some((e) => e.extnID === OID_PKIX_OCSP_NOCHECK),
  );
}

/**
 * Validates a single OCSP response (RFC 6960) against a target certificate (`targetNode`)
 * and its verified issuer CA (`issuerNode`) at `referenceTime` / `verificationTime`.
 *
 * Os passos, na ordem: ler a resposta; conferir o envelope (data, extensões, algoritmo); achar
 * a entrada que fala deste certificado; descobrir quem assinou e conferir a assinatura; conferir
 * que esse respondente podia responder pela AC; conferir as datas da entrada; e só então ler o
 * estado do certificado. O primeiro passo que falha encerra a avaliação.
 */
export async function evaluateOcspForCertificate(params: {
  rawOcsp: Buffer | Uint8Array | string;
  targetNode: ParsedX509Node;
  issuerNode: ParsedX509Node;
  extraResponderCerts?: unknown[];
  rawCrls?: Array<Buffer | Uint8Array | string>;
  referenceTime: Date;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): Promise<SingleEvidenceEvaluation> {
  const {
    rawOcsp,
    targetNode,
    issuerNode,
    extraResponderCerts = [],
    rawCrls = [],
    referenceTime,
    verificationTime,
    freshness,
  } = params;

  let der: Buffer;
  try {
    der = toDerBufferFromRevocationInput(rawOcsp);
  } catch (err) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        err instanceof Error
          ? err.message
          : 'Formato de resposta OCSP inválido ou corrompido.',
    };
  }

  const parsedOcsp = parseBasicOcspResponse(der);
  if ('source' in parsedOcsp) return parsedOcsp;
  const { basicOcsp } = parsedOcsp;

  const envelope = checkOcspEnvelope(basicOcsp);
  if ('source' in envelope) return envelope;
  const { producedAt, allowedSigAlg } = envelope;

  const single = findOcspSingleResponse(basicOcsp, targetNode, issuerNode);
  if ('source' in single) return single;
  const { matchedSingleResponse } = single;

  const responder = await findVerifiedOcspResponder({
    basicOcsp,
    issuerNode,
    extraResponderCerts,
    allowedSigAlg,
  });
  if ('source' in responder) return responder;

  const responderProblem = await checkOcspResponderAuthorization({
    verifiedResponder: responder.verifiedResponder,
    issuerNode,
    producedAt,
    rawCrls,
    verificationTime,
    freshness,
  });
  if (responderProblem) return responderProblem;

  const dates = checkOcspSingleResponseDates(
    matchedSingleResponse,
    producedAt,
    verificationTime,
  );
  if ('source' in dates) return dates;

  return ocspStatusForCertificate({
    matchedSingleResponse,
    targetNode,
    producedAt,
    thisUpdate: dates.thisUpdate,
    nextUpdate: dates.nextUpdate,
    referenceTime,
    verificationTime,
    freshness,
  });
}

/**
 * Lê a estrutura da resposta OCSP e devolve a parte assinada (BasicOCSPResponse). Resposta de
 * erro do servidor (tryLater e outras) não é evidência e sai daqui com o motivo.
 */
function parseBasicOcspResponse(
  der: Buffer,
): SingleEvidenceEvaluation | { basicOcsp: pkijs.BasicOCSPResponse } {
  const asn1 = asn1js.fromBER(
    der.buffer.slice(
      der.byteOffset,
      der.byteOffset + der.byteLength,
    ) as ArrayBuffer,
  );
  if (!asn1.result || asn1.offset === -1 || asn1.offset !== der.length) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Falha ao decodificar estrutura ASN.1 DER da resposta OCSP.',
    };
  }

  let basicOcsp: pkijs.BasicOCSPResponse;
  try {
    const ocspResp = new pkijs.OCSPResponse({ schema: asn1.result });
    const statusCode = ocspResp.responseStatus.valueBlock.valueDec;
    if (statusCode === 3) {
      // RFC 6960 §2.3: respostas de erro não são assinadas; não identificam certificado nem
      // emissor e por isso não são evidência de nada (6F.2C-R).
      return {
        source: 'OCSP',
        matchKind: 'UNAVAILABLE',
        certStatus: 'TRY_LATER',
        subIndication: 'TRY_LATER',
        error: 'O servidor OCSP retornou status tryLater (3), sem resposta assinada.',
      };
    }
    if (statusCode !== 0) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `OCSPResponseStatus não bem-sucedido (${statusCode}).`,
      };
    }
    if (
      !ocspResp.responseBytes ||
      ocspResp.responseBytes.responseType !== OID_PKIX_OCSP_BASIC
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `responseType OCSP inválido (${ocspResp.responseBytes?.responseType || 'ausente'}); esperado id-pkix-ocsp-basic (${OID_PKIX_OCSP_BASIC}).`,
      };
    }
    const basicView = ocspResp.responseBytes.response.valueBlock.valueHexView;
    const basicAsn1 = asn1js.fromBER(
      basicView.buffer.slice(
        basicView.byteOffset,
        basicView.byteOffset + basicView.byteLength,
      ) as ArrayBuffer,
    );
    if (!basicAsn1.result || basicAsn1.offset === -1) {
      throw new Error('ASN.1 de BasicOCSPResponse inválido.');
    }
    basicOcsp = new pkijs.BasicOCSPResponse({ schema: basicAsn1.result });
  } catch (err) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Estrutura OCSPResponse/BasicOCSPResponse inválida: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { basicOcsp };
}

/**
 * O envelope da resposta é aceitável? producedAt válido, nenhuma extensão crítica desconhecida,
 * algoritmo de assinatura permitido e ao menos uma entrada. Devolve producedAt e o algoritmo.
 */
function checkOcspEnvelope(basicOcsp: pkijs.BasicOCSPResponse):
  | SingleEvidenceEvaluation
  | { producedAt: Date; allowedSigAlg: (typeof ALLOWED_SIGNATURE_OIDS)[string] } {
  const tbsData = basicOcsp.tbsResponseData;
  const producedAt = tbsData.producedAt;
  if (!(producedAt instanceof Date) || Number.isNaN(producedAt.getTime())) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Campo producedAt inválido em BasicOCSPResponse.',
    };
  }

  // Check responseExtensions for unrecognized critical extensions
  const respExts = tbsData.responseExtensions || [];
  for (const ext of respExts) {
    if (
      ext.critical &&
      !RECOGNIZED_OCSP_RESPONSE_CRITICAL_EXT_OIDS.has(ext.extnID)
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `BasicOCSPResponse contém extensão crítica não reconhecida (${ext.extnID}).`,
      };
    }
  }

  const sigAlgOid = basicOcsp.signatureAlgorithm?.algorithmId || '';
  const allowedSigAlg = ALLOWED_SIGNATURE_OIDS[sigAlgOid];
  if (!allowedSigAlg) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Algoritmo de assinatura de BasicOCSPResponse não permitido (${sigAlgOid}).`,
    };
  }

  if (!Array.isArray(tbsData.responses) || tbsData.responses.length === 0) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'BasicOCSPResponse não contém nenhuma entrada SingleResponse.',
    };
  }

  return { producedAt, allowedSigAlg };
}

/**
 * Qual entrada da resposta fala deste certificado? Compara o CertID (hash do nome e da chave da
 * AC, mais o número de série) com o certificado consultado e a AC que o emitiu.
 */
function findOcspSingleResponse(
  basicOcsp: pkijs.BasicOCSPResponse,
  targetNode: ParsedX509Node,
  issuerNode: ParsedX509Node,
): SingleEvidenceEvaluation | { matchedSingleResponse: pkijs.SingleResponse } {
  const tbsData = basicOcsp.tbsResponseData;

  // Step 1: Match CertID against (targetNode, issuerNode)
  const issuerNameDer = Buffer.from(
    issuerNode.pkiCert.subject.toSchema().toBER(false),
  );
  const issuerKeyBytes = Buffer.from(
    issuerNode.pkiCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock
      .valueHexView,
  );

  let matchedSingleResponse: pkijs.SingleResponse | null = null;
  let sawSameIssuerOtherSerial = false;
  let sawSameSerialOtherIssuer = false;

  for (const sr of tbsData.responses) {
    const hashAlgOid = sr.certID?.hashAlgorithm?.algorithmId || '';
    const nodeHashAlg = ALLOWED_CERTID_HASH_OIDS[hashAlgOid];
    if (!nodeHashAlg) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Algoritmo de hash em OCSP CertID não suportado (${hashAlgOid}).`,
      };
    }

    const expectedNameHash = crypto
      .createHash(nodeHashAlg)
      .update(issuerNameDer)
      .digest();
    const expectedKeyHash = crypto
      .createHash(nodeHashAlg)
      .update(issuerKeyBytes)
      .digest();

    const actualNameHash = Buffer.from(
      sr.certID.issuerNameHash.valueBlock.valueHexView,
    );
    const actualKeyHash = Buffer.from(
      sr.certID.issuerKeyHash.valueBlock.valueHexView,
    );

    const issuerMatches =
      actualNameHash.length === expectedNameHash.length &&
      crypto.timingSafeEqual(actualNameHash, expectedNameHash) &&
      actualKeyHash.length === expectedKeyHash.length &&
      crypto.timingSafeEqual(actualKeyHash, expectedKeyHash);

    const serialMatches = serialNumbersEqual(
      sr.certID.serialNumber,
      targetNode.pkiCert.serialNumber,
    );

    if (issuerMatches && serialMatches) {
      matchedSingleResponse = sr;
      break;
    }
    if (issuerMatches && !serialMatches) {
      sawSameIssuerOtherSerial = true;
    } else if (!issuerMatches && serialMatches) {
      sawSameSerialOtherIssuer = true;
    }
  }

  if (!matchedSingleResponse) {
    if (sawSameIssuerOtherSerial) {
      return {
        source: 'OCSP',
        matchKind: 'UNRELATED_ISSUER',
        subIndication: 'OCSP_CERT_ID_MISMATCH',
        error: `O CertID da resposta OCSP pertence a outro número de série emitido por "${issuerNode.commonName}", e não ao certificado "${targetNode.commonName}".`,
      };
    }
    if (sawSameSerialOtherIssuer) {
      return {
        source: 'OCSP',
        matchKind: 'UNRELATED_ISSUER',
        subIndication: 'OCSP_CERT_ID_MISMATCH',
        error: `O CertID da resposta OCSP possui o mesmo número de série, mas foi emitido por outra Autoridade Certificadora (issuerNameHash/issuerKeyHash divergentes).`,
      };
    }
    return {
      source: 'OCSP',
      matchKind: 'UNRELATED_ISSUER',
      subIndication: 'OCSP_CERT_ID_MISMATCH',
      error: `Resposta OCSP não contém CertID correspondente ao certificado "${targetNode.commonName}".`,
    };
  }

  return { matchedSingleResponse };
}

/**
 * Quem assinou a resposta? Junta os certificados candidatos (a própria AC e os que vieram com a
 * resposta), filtra pelo ResponderID e devolve o primeiro cuja chave confere a assinatura.
 */
async function findVerifiedOcspResponder(params: {
  basicOcsp: pkijs.BasicOCSPResponse;
  issuerNode: ParsedX509Node;
  extraResponderCerts: unknown[];
  allowedSigAlg: (typeof ALLOWED_SIGNATURE_OIDS)[string];
}): Promise<SingleEvidenceEvaluation | { verifiedResponder: ParsedX509Node }> {
  const { basicOcsp, issuerNode, extraResponderCerts, allowedSigAlg } = params;
  const tbsData = basicOcsp.tbsResponseData;

  // Step 2: Identify the effective OCSP Responder certificate matching responderID
  const candidatePool: ParsedX509Node[] = [issuerNode];
  const seenDer = new Set<string>([issuerNode.der.toString('hex')]);

  const rawCandidates: unknown[] = [
    ...(basicOcsp.certs || []),
    ...extraResponderCerts,
  ];
  for (const rawCand of rawCandidates) {
    try {
      const node = parseX509Node(rawCand);
      const hex = node.der.toString('hex');
      if (!seenDer.has(hex)) {
        seenDer.add(hex);
        candidatePool.push(node);
      }
    } catch {
      // Ignore malformed auxiliary cert
    }
  }

  const responderId = tbsData.responderID;
  const responderMatchesId = candidatePool.filter((cand) => {
    if (responderId instanceof pkijs.RelativeDistinguishedNames) {
      return cand.pkiCert.subject.isEqual(responderId);
    }
    if (responderId instanceof asn1js.OctetString) {
      const targetKeyHashHex = Buffer.from(
        responderId.valueBlock.valueHexView,
      )
        .toString('hex')
        .toLowerCase();
      const spkiKeyHashHex = crypto
        .createHash('sha1')
        .update(
          Buffer.from(
            cand.pkiCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock
              .valueHexView,
          ),
        )
        .digest('hex')
        .toLowerCase();
      return (
        spkiKeyHashHex === targetKeyHashHex ||
        (cand.skiHex !== null && cand.skiHex.toLowerCase() === targetKeyHashHex)
      );
    }
    return false;
  });

  if (responderMatchesId.length === 0) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        'Certificado do respondente OCSP correspondente ao ResponderID não encontrado.',
    };
  }

  // Step 3: Verify cryptographic signature of BasicOCSPResponse over tbsResponseData.tbsView
  const engine = pkijs.getEngine();
  if (!engine?.crypto) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Motor criptográfico pkijs indisponível para verificar OCSP.',
    };
  }

  const tbsBytes = tbsData.tbsView;
  const tbsArrayBuffer = tbsBytes.buffer.slice(
    tbsBytes.byteOffset,
    tbsBytes.byteOffset + tbsBytes.byteLength,
  ) as ArrayBuffer;

  let verifiedResponder: ParsedX509Node | null = null;
  for (const cand of responderMatchesId) {
    try {
      const sigOk = await engine.crypto.verifyWithPublicKey(
        tbsArrayBuffer,
        basicOcsp.signature,
        cand.pkiCert.subjectPublicKeyInfo,
        basicOcsp.signatureAlgorithm,
        allowedSigAlg.digestName,
      );
      if (sigOk) {
        verifiedResponder = cand;
        break;
      }
    } catch {
      // Continue trying next candidate
    }
  }

  if (!verifiedResponder) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        'Assinatura criptográfica de BasicOCSPResponse inválida perante o certificado do respondente.',
    };
  }

  return { verifiedResponder };
}

/**
 * Esse respondente podia responder pela AC (RFC 6960 §4.2.2.2)? Vale a própria AC, ou um
 * respondente delegado emitido por ela, com permissão de assinar OCSP, vigente e não revogado.
 * Devolve o motivo da recusa, ou `null` se passou.
 */
async function checkOcspResponderAuthorization(params: {
  verifiedResponder: ParsedX509Node;
  issuerNode: ParsedX509Node;
  producedAt: Date;
  rawCrls: Array<Buffer | Uint8Array | string>;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): Promise<SingleEvidenceEvaluation | null> {
  const {
    verifiedResponder,
    issuerNode,
    producedAt,
    rawCrls,
    verificationTime,
    freshness,
  } = params;
  const issuerKeyBytes = Buffer.from(
    issuerNode.pkiCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock
      .valueHexView,
  );

  // Step 4: Verify Responder Authorization, Chain & Trust per RFC 6960 §4.2.2.2
  const isDirectIssuer =
    verifiedResponder.der.equals(issuerNode.der) ||
    (verifiedResponder.pkiCert.subject.isEqual(issuerNode.pkiCert.subject) &&
      Buffer.from(
        verifiedResponder.pkiCert.subjectPublicKeyInfo.subjectPublicKey
          .valueBlock.valueHexView,
      ).equals(issuerKeyBytes));

  if (isDirectIssuer) {
    if (
      !issuerNode.basicConstraints.present ||
      !issuerNode.basicConstraints.cA ||
      issuerNode.basicConstraints.malformed ||
      issuerNode.keyUsage.malformed
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `AC emissora "${issuerNode.commonName}" possui restrições X.509 inválidas para responder OCSP.`,
      };
    }
    if (producedAt < issuerNode.validFrom || producedAt > issuerNode.validTo) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Resposta OCSP produzida fora da janela de vigência da AC emissora "${issuerNode.commonName}".`,
      };
    }
  } else {
    // Delegated OCSP Responder (RFC 6960 §4.2.2.2):
    // 1. Must be issued directly by issuerNode (the CA that issued targetNode)
    const issuedByTargetCa =
      !verifiedResponder.isSelfIssued &&
      verifiedResponder.pkiCert.issuer.isEqual(issuerNode.pkiCert.subject) &&
      (!verifiedResponder.akiHex ||
        !issuerNode.skiHex ||
        verifiedResponder.akiHex.toLowerCase() ===
          issuerNode.skiHex.toLowerCase()) &&
      issuerNode.basicConstraints.present &&
      issuerNode.basicConstraints.cA &&
      issuerNode.keyUsage.present &&
      issuerNode.keyUsage.keyCertSign &&
      (() => {
        try {
          return verifiedResponder.x509.verify(issuerNode.x509.publicKey);
        } catch {
          return false;
        }
      })();

    if (!issuedByTargetCa) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Respondente OCSP delegado "${verifiedResponder.commonName}" não foi emitido diretamente pela AC "${issuerNode.commonName}" que emitiu o certificado consultado (RFC 6960 §4.2.2.2).`,
      };
    }

    // 2. Must have BasicConstraints cA=false, valid KeyUsage, and no malformed/unrecognized critical extensions
    if (
      verifiedResponder.basicConstraints.malformed ||
      verifiedResponder.keyUsage.malformed ||
      verifiedResponder.extendedKeyUsage.malformed ||
      verifiedResponder.hasUnrecognizedCriticalExtension ||
      verifiedResponder.basicConstraints.cA
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Certificado do respondente OCSP delegado "${verifiedResponder.commonName}" possui BasicConstraints cA=true ou extensões X.509 inválidas.`,
      };
    }

    if (verifiedResponder.keyUsage.present) {
      const hasSigBit =
        verifiedResponder.keyUsage.digitalSignature ||
        verifiedResponder.keyUsage.nonRepudiation;
      if (!hasSigBit || verifiedResponder.keyUsage.keyCertSign) {
        return {
          source: 'OCSP',
          matchKind: 'INVALID_EVIDENCE',
          subIndication: 'REVOCATION_EVIDENCE_INVALID',
          error: `Certificado do respondente OCSP delegado "${verifiedResponder.commonName}" não possui KeyUsage digitalSignature válido.`,
        };
      }
    }

    // 3. Must have ExtendedKeyUsage containing id-kp-OCSPSigning (1.3.6.1.5.5.7.3.9)
    const hasOcspSigningEku =
      verifiedResponder.extendedKeyUsage.present &&
      verifiedResponder.extendedKeyUsage.oids.includes(OID_KP_OCSP_SIGNING);

    if (!hasOcspSigningEku) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Respondente OCSP delegado "${verifiedResponder.commonName}" não possui autorização ExtendedKeyUsage id-kp-OCSPSigning (1.3.6.1.5.5.7.3.9) exigida pela RFC 6960 §4.2.2.2.`,
      };
    }

    // 4. Temporal validity of delegated responder and issuer CA at producedAt
    if (
      producedAt < verifiedResponder.validFrom ||
      producedAt > verifiedResponder.validTo ||
      producedAt < issuerNode.validFrom ||
      producedAt > issuerNode.validTo
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Certificado do respondente OCSP delegado "${verifiedResponder.commonName}" estava fora de vigência em producedAt (${producedAt.toISOString()}).`,
      };
    }

    // 5. Delegated responder revocation (RFC 6960 §4.2.2.2.1):
    //    - revoked in an authentic CRL from issuerNode -> evidence rejected;
    //    - without id-pkix-ocsp-nocheck, non-revocation of the responder MUST be demonstrated
    //      by an authentic CRL; otherwise the response is not trusted as evidence.
    const responderStatus = await ocspResponderStatusFromCrls({
      responderNode: verifiedResponder,
      issuerNode,
      rawCrls,
      producedAt,
      verificationTime,
      freshness,
    });
    if (responderStatus === 'REVOKED') {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Certificado do respondente OCSP delegado "${verifiedResponder.commonName}" encontrava-se revogado em producedAt.`,
      };
    }
    if (
      responderStatus !== 'GOOD' &&
      !hasOcspNoCheckExtension(verifiedResponder)
    ) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: `Respondente OCSP delegado "${verifiedResponder.commonName}" não possui id-pkix-ocsp-nocheck e sua não revogação não foi demonstrada por CRL autêntica.`,
      };
    }
  }

  return null;
}

/**
 * As datas da entrada fazem sentido? thisUpdate válido, período coerente com producedAt e nada
 * emitido no futuro. Devolve thisUpdate e nextUpdate (opcional), ou o motivo da recusa.
 */
function checkOcspSingleResponseDates(
  matchedSingleResponse: pkijs.SingleResponse,
  producedAt: Date,
  verificationTime: Date,
): SingleEvidenceEvaluation | { thisUpdate: Date; nextUpdate: Date | undefined } {
  // Step 5: Validate SingleResponse temporal fields (producedAt, thisUpdate, nextUpdate)
  const thisUpdate = matchedSingleResponse.thisUpdate;
  const defaultZeroDateMs = new Date(0, 0, 0).getTime();
  const nextUpdate =
    matchedSingleResponse.nextUpdate instanceof Date &&
    !Number.isNaN(matchedSingleResponse.nextUpdate.getTime()) &&
    matchedSingleResponse.nextUpdate.getTime() !== defaultZeroDateMs
      ? matchedSingleResponse.nextUpdate
      : undefined;

  // nextUpdate é opcional (RFC 6960 §2.4); sem ele a política de frescor limita a idade.
  if (
    !(thisUpdate instanceof Date) ||
    Number.isNaN(thisUpdate.getTime()) ||
    thisUpdate.getTime() === defaultZeroDateMs ||
    (nextUpdate !== undefined && nextUpdate < thisUpdate) ||
    producedAt < thisUpdate ||
    (nextUpdate !== undefined && producedAt > nextUpdate)
  ) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      producedAt,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        'Período temporal (thisUpdate / nextUpdate / producedAt) da resposta OCSP ausente ou incompatível.',
    };
  }

  if (thisUpdate > verificationTime || producedAt > verificationTime) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      producedAt,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Resposta OCSP emitida no futuro em relação ao instante de verificação (${verificationTime.toISOString()}).`,
    };
  }

  return { thisUpdate, nextUpdate };
}

/**
 * Com a resposta já aceita: o que ela diz do certificado? "good" só prova não revogação quando
 * tem frescor suficiente; "revoked" traz quando e por quê; "unknown" não prova nada.
 */
function ocspStatusForCertificate(params: {
  matchedSingleResponse: pkijs.SingleResponse;
  targetNode: ParsedX509Node;
  producedAt: Date;
  thisUpdate: Date;
  nextUpdate: Date | undefined;
  referenceTime: Date;
  verificationTime: Date;
  freshness: RevocationFreshnessContext;
}): SingleEvidenceEvaluation {
  const {
    matchedSingleResponse,
    targetNode,
    producedAt,
    thisUpdate,
    nextUpdate,
    referenceTime,
    verificationTime,
    freshness,
  } = params;

  // Check SingleResponse extensions
  const singleExts = matchedSingleResponse.singleExtensions || [];
  const singleExtInfo = parseEntryReasonAndInvalidity(
    singleExts,
    RECOGNIZED_OCSP_SINGLE_CRITICAL_EXT_OIDS,
  );
  if (
    singleExtInfo.malformed ||
    singleExtInfo.hasUnrecognizedCriticalExtension
  ) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      producedAt,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error:
        'SingleResponse OCSP contém extensão crítica desconhecida ou malformada.',
    };
  }

  // Parse CertStatus tag: [0] good, [1] revoked, [2] unknown
  const cs = matchedSingleResponse.certStatus as {
    idBlock?: { tagClass?: number; tagNumber?: number };
    valueBlock?: { value?: unknown[] };
  };
  if (!cs || cs.idBlock?.tagClass !== 3) {
    return {
      source: 'OCSP',
      matchKind: 'INVALID_EVIDENCE',
      thisUpdate,
      nextUpdate,
      producedAt,
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Campo certStatus malformado em SingleResponse OCSP.',
    };
  }

  const statusTag = cs.idBlock.tagNumber;

  if (statusTag === 0) {
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
        source: 'OCSP',
        matchKind: 'NOT_FRESH',
        certStatus: 'GOOD',
        thisUpdate,
        nextUpdate,
        producedAt,
        subIndication: 'TRY_LATER',
        error: `Resposta OCSP autêntica sem frescor suficiente para "${targetNode.commonName}": ${problem}.`,
      };
    }
  }

  if (statusTag === 0) {
    return {
      source: 'OCSP',
      matchKind: 'MATCHED_VALID',
      certStatus: 'GOOD',
      thisUpdate,
      nextUpdate,
      producedAt,
    };
  }

  if (statusTag === 2) {
    return {
      source: 'OCSP',
      matchKind: 'MATCHED_VALID',
      certStatus: 'UNKNOWN',
      thisUpdate,
      nextUpdate,
      producedAt,
      subIndication: 'OCSP_STATUS_UNKNOWN',
      error: `O respondente OCSP retornou certStatus = unknown para o certificado "${targetNode.commonName}".`,
    };
  }

  if (statusTag === 1) {
    const revChildren = cs.valueBlock?.value || [];
    const revTimeNode = revChildren[0];
    let revokedAt: Date | undefined;
    if (
      revTimeNode instanceof asn1js.GeneralizedTime ||
      revTimeNode instanceof asn1js.UTCTime
    ) {
      const d = revTimeNode.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        revokedAt = d;
      }
    }
    if (!revokedAt || revokedAt > producedAt) {
      return {
        source: 'OCSP',
        matchKind: 'INVALID_EVIDENCE',
        thisUpdate,
        nextUpdate,
        producedAt,
        subIndication: 'REVOCATION_EVIDENCE_INVALID',
        error: revokedAt
          ? 'revocationTime posterior ao producedAt da resposta OCSP.'
          : 'Campo revocationTime ausente ou inválido em RevokedInfo OCSP.',
      };
    }

    let reasonCode = singleExtInfo.reasonCode;
    if (revChildren[1] && typeof revChildren[1] === 'object') {
      const innerVals = (
        revChildren[1] as { valueBlock?: { value?: unknown[] } }
      ).valueBlock?.value;
      if (
        Array.isArray(innerVals) &&
        innerVals[0] instanceof asn1js.Enumerated
      ) {
        reasonCode = innerVals[0].valueBlock.valueDec;
      }
    }

    const reasonName = mapCrlReasonCodeToName(reasonCode);
    const isHold = reasonCode === 6;

    return {
      source: 'OCSP',
      matchKind: 'MATCHED_VALID',
      certStatus: isHold ? 'CERTIFICATE_HOLD' : 'REVOKED',
      thisUpdate,
      nextUpdate,
      producedAt,
      revokedAt,
      invalidityDate: singleExtInfo.invalidityDate,
      reasonCode,
      reasonName,
    };
  }

  return {
    source: 'OCSP',
    matchKind: 'INVALID_EVIDENCE',
    thisUpdate,
    nextUpdate,
    producedAt,
    subIndication: 'REVOCATION_EVIDENCE_INVALID',
    error: `Tag certStatus OCSP desconhecida (${String(statusTag)}).`,
  };
}
