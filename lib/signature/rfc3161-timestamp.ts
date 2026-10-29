import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { timingSafeEqualStr } from './crypto-utils.ts';
import {
  evaluateX509ChainAndTrust,
  parseX509Node,
  resolveCmsSignerCertificate,
  type ParsedX509Node,
} from './icp-chain.ts';
import type {
  CertificateRevocationCheckSummary,
  ExternalPoeEvidence,
  PadesTemporalValidityResult,
  PadesVerificationOptions,
  PdfSignatureRevisionSummary,
} from './types.ts';
import { evaluateTsaChainRevocation } from './revocation-validator.ts';
import { withOnlineRevocationEvidence } from './revocation-fetch.ts';

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine already configured
}

export const OID_SIGNATURE_TIME_STAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
export const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
export const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12';
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';

const ALLOWED_DIGEST_OIDS: Record<
  string,
  { name: string; nodeAlg: 'sha256' | 'sha384' | 'sha512' }
> = {
  '2.16.840.1.101.3.4.2.1': { name: 'SHA-256', nodeAlg: 'sha256' },
  '2.16.840.1.101.3.4.2.2': { name: 'SHA-384', nodeAlg: 'sha384' },
  '2.16.840.1.101.3.4.2.3': { name: 'SHA-512', nodeAlg: 'sha512' },
};

const ALLOWED_SIGNATURE_OIDS: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'SHA256withRSA',
  '1.2.840.113549.1.1.12': 'SHA384withRSA',
  '1.2.840.113549.1.1.13': 'SHA512withRSA',
  '1.2.840.10045.4.3.2': 'ECDSAwithSHA256',
  '1.2.840.10045.4.3.3': 'ECDSAwithSHA384',
  '1.2.840.10045.4.3.4': 'ECDSAwithSHA512',
};

const DEFAULT_TRUSTED_EXTERNAL_POE_SOURCES = new Set<string>([
  'PSYWRITE_AUDIT_LEDGER',
  'SNCR_ANVISA_RECEIPT',
  'ITI_VALIDADOR_RECEIPT',
  'ICP_BRASIL_ARCHIVE_POE',
]);

function extractOctetStringBytes(octet: asn1js.OctetString | undefined): Buffer | null {
  if (!octet) return null;
  if (
    octet.valueBlock.valueHexView &&
    octet.valueBlock.valueHexView.byteLength > 0
  ) {
    return Buffer.from(octet.valueBlock.valueHexView);
  }
  if (Array.isArray(octet.valueBlock.value) && octet.valueBlock.value.length > 0) {
    const chunks: Buffer[] = [];
    for (const part of octet.valueBlock.value) {
      if (part instanceof asn1js.OctetString) {
        const sub = extractOctetStringBytes(part);
        if (sub) chunks.push(sub);
      }
    }
    if (chunks.length > 0) {
      return Buffer.concat(chunks);
    }
  }
  return null;
}

function verifyTsaSigningCertificateAttr(
  signedAttrs: pkijs.SignedAndUnsignedAttributes,
  signerCertDer: Buffer,
): { present: boolean; valid: boolean; error?: string } {
  const attrV2 = signedAttrs.attributes.find(
    (a) => a.type === OID_SIGNING_CERTIFICATE_V2,
  );
  const attrV1 = signedAttrs.attributes.find(
    (a) => a.type === OID_SIGNING_CERTIFICATE,
  );

  if (!attrV2 && !attrV1) {
    return { present: false, valid: true };
  }

  try {
    if (attrV2) {
      const seq = attrV2.values?.[0];
      if (!(seq instanceof asn1js.Sequence) || seq.valueBlock.value.length === 0) {
        return {
          present: true,
          valid: false,
          error: 'Estrutura ASN.1 de signingCertificateV2 da TSA inválida.',
        };
      }
      const certsSeq = seq.valueBlock.value[0];
      if (
        !(certsSeq instanceof asn1js.Sequence) ||
        certsSeq.valueBlock.value.length === 0
      ) {
        return {
          present: true,
          valid: false,
          error: 'Lista de ESSCertIDv2 vazia em signingCertificateV2 da TSA.',
        };
      }
      const firstEssCertId = certsSeq.valueBlock.value[0];
      if (!(firstEssCertId instanceof asn1js.Sequence)) {
        return {
          present: true,
          valid: false,
          error: 'ESSCertIDv2 malformado na TSA.',
        };
      }
      const items = firstEssCertId.valueBlock.value;
      let hashAlgOid = '2.16.840.1.101.3.4.2.1';
      let certHashOctet: asn1js.OctetString | null = null;

      if (items[0] instanceof asn1js.OctetString) {
        certHashOctet = items[0];
      } else if (
        items[0] instanceof asn1js.Sequence &&
        items[1] instanceof asn1js.OctetString
      ) {
        const algId = new pkijs.AlgorithmIdentifier({ schema: items[0] });
        hashAlgOid = algId.algorithmId;
        certHashOctet = items[1];
      }

      if (!certHashOctet) {
        return {
          present: true,
          valid: false,
          error: 'certHash ausente em ESSCertIDv2 da TSA.',
        };
      }

      const algEntry = ALLOWED_DIGEST_OIDS[hashAlgOid];
      if (!algEntry) {
        return {
          present: true,
          valid: false,
          error: `Algoritmo de hash não suportado em ESSCertIDv2 da TSA (${hashAlgOid}).`,
        };
      }

      const attrHashBytes = Buffer.from(certHashOctet.valueBlock.valueHexView);
      const expectedHashBytes = crypto
        .createHash(algEntry.nodeAlg)
        .update(signerCertDer)
        .digest();

      if (
        attrHashBytes.length !== expectedHashBytes.length ||
        !crypto.timingSafeEqual(attrHashBytes, expectedHashBytes)
      ) {
        return {
          present: true,
          valid: false,
          error:
            'Hash do certificado em signingCertificateV2 da TSA diverge do certificado da TSA.',
        };
      }
      return { present: true, valid: true };
    }

    if (attrV1) {
      const seq = attrV1.values?.[0];
      const certsSeq =
        seq instanceof asn1js.Sequence ? seq.valueBlock.value[0] : null;
      const firstEssCertId =
        certsSeq instanceof asn1js.Sequence ? certsSeq.valueBlock.value[0] : null;
      if (
        !(firstEssCertId instanceof asn1js.Sequence) ||
        !(firstEssCertId.valueBlock.value[0] instanceof asn1js.OctetString)
      ) {
        return {
          present: true,
          valid: false,
          error: 'ESSCertID malformado em signingCertificate da TSA.',
        };
      }
      const attrHashBytes = Buffer.from(
        firstEssCertId.valueBlock.value[0].valueBlock.valueHexView,
      );
      const expectedSha1 = crypto
        .createHash('sha1')
        .update(signerCertDer)
        .digest();
      if (
        attrHashBytes.length !== expectedSha1.length ||
        !crypto.timingSafeEqual(attrHashBytes, expectedSha1)
      ) {
        return {
          present: true,
          valid: false,
          error:
            'Hash do certificado em signingCertificate da TSA diverge do certificado da TSA.',
        };
      }
      return { present: true, valid: true };
    }
  } catch (err) {
    return {
      present: true,
      valid: false,
      error: `Erro ao validar atributo signingCertificate da TSA: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { present: false, valid: true };
}

export interface Rfc3161TokenValidationResult {
  sourceKind: 'RFC3161_SIGNATURE_TIMESTAMP' | 'RFC3161_DOC_TIMESTAMP';
  validAndTrusted: boolean;
  isHardInvalid: boolean;
  signatureValid: boolean;
  messageImprintValid: boolean;
  genTime?: Date;
  tsaSignerSubject?: string;
  tsaKeyUsageValid: boolean;
  tsaExtendedKeyUsageValid: boolean;
  tsaExtendedKeyUsageCritical: boolean;
  tsaChainStatus:
    | 'VALID'
    | 'SELF_SIGNED'
    | 'INCOMPLETE_CHAIN'
    | 'UNTRUSTED_ROOT'
    | 'INVALID';
  tsaChainValid: boolean;
  tsaRootTrusted: boolean;
  tsaRevocationChecked: boolean;
  tsaTrustComplete: boolean;
  tsaRevocationSummaries?: CertificateRevocationCheckSummary[];
  subIndication?: string;
  error?: string;
}

export interface ValidateRfc3161TokenParams {
  tokenDer: Buffer;
  stampedContentBytes: Buffer;
  sourceKind: 'RFC3161_SIGNATURE_TIMESTAMP' | 'RFC3161_DOC_TIMESTAMP';
  extraCandidateCerts?: unknown[];
  trustedTsaCerts?: unknown[];
  trustedTsaRootPems?: string[];
  fallbackTrustedCerts?: unknown[];
  fallbackTrustedRootPems?: string[];
  intermediateCerts?: unknown[];
  intermediatePems?: string[];
  tsaIntermediateCerts?: unknown[];
  tsaIntermediatePems?: string[];
  allowCustomTrustAnchors?: boolean;
  /** Lote 6F.2C: injected offline revocation evidence (CRL/OCSP) and policy for the TSA chain. */
  revocationOptions?: PadesVerificationOptions;
  verificationTime?: Date;
}

/**
 * Validates an RFC 3161 TimeStampToken structurally, cryptographically,
 * and against TSA X.509 certificate / chain / trust anchor constraints.
 */
export async function validateRfc3161TimestampToken(
  params: ValidateRfc3161TokenParams,
): Promise<Rfc3161TokenValidationResult> {
  const buildHardInvalid = (
    subIndication: string,
    error: string,
    overrides: Partial<Rfc3161TokenValidationResult> = {},
  ): Rfc3161TokenValidationResult => ({
    sourceKind: params.sourceKind,
    validAndTrusted: false,
    isHardInvalid: true,
    signatureValid: false,
    messageImprintValid: false,
    tsaKeyUsageValid: false,
    tsaExtendedKeyUsageValid: false,
    tsaExtendedKeyUsageCritical: false,
    tsaChainStatus: 'INVALID',
    tsaChainValid: false,
    tsaRootTrusted: false,
    tsaRevocationChecked: false,
    tsaTrustComplete: false,
    subIndication,
    error,
    ...overrides,
  });

  const asn1 = asn1js.fromBER(
    params.tokenDer.buffer.slice(
      params.tokenDer.byteOffset,
      params.tokenDer.byteOffset + params.tokenDer.byteLength,
    ) as ArrayBuffer,
  );
  if (!asn1.result || asn1.offset === -1) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      'Falha ao decodificar estrutura ASN.1 do TimeStampToken RFC 3161.',
    );
  }

  let contentInfo: pkijs.ContentInfo;
  let signedData: pkijs.SignedData;
  try {
    contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
    if (contentInfo.contentType !== OID_SIGNED_DATA) {
      return buildHardInvalid(
        'TIMESTAMP_FORMAT_FAILURE',
        `ContentInfo.contentType do carimbo de tempo inválido (${contentInfo.contentType}).`,
      );
    }
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch (err) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `Estrutura CMS SignedData do carimbo de tempo inválida: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (signedData.signerInfos.length !== 1) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `TimeStampToken RFC 3161 exige exatamente 1 SignerInfo, mas encontrou ${signedData.signerInfos.length}.`,
    );
  }

  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `eContentType do TimeStampToken inválido (${signedData.encapContentInfo.eContentType}); esperado id-ct-TSTInfo (${OID_TST_INFO}).`,
    );
  }

  const tstInfoDer = extractOctetStringBytes(signedData.encapContentInfo.eContent);
  if (!tstInfoDer || tstInfoDer.length === 0) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      'TSTInfo ausente ou vazio em encapContentInfo.eContent.',
    );
  }

  let tstInfo: pkijs.TSTInfo;
  try {
    const tstAsn1 = asn1js.fromBER(
      tstInfoDer.buffer.slice(
        tstInfoDer.byteOffset,
        tstInfoDer.byteOffset + tstInfoDer.byteLength,
      ) as ArrayBuffer,
    );
    if (!tstAsn1.result || tstAsn1.offset === -1) {
      throw new Error('ASN.1 de TSTInfo truncado ou inválido.');
    }
    tstInfo = new pkijs.TSTInfo({ schema: tstAsn1.result });
  } catch (err) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `Falha ao decodificar TSTInfo RFC 3161: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (tstInfo.version !== 1) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `Versão de TSTInfo RFC 3161 não suportada (${tstInfo.version}); esperado v1 (1).`,
    );
  }

  if (!tstInfo.policy || typeof tstInfo.policy !== 'string') {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      'Campo TSAPolicyId ausente em TSTInfo.',
    );
  }

  const genTime = tstInfo.genTime;
  if (!(genTime instanceof Date) || Number.isNaN(genTime.getTime())) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      'Campo genTime inválido em TSTInfo RFC 3161.',
    );
  }

  const tsaSignerInfo = signedData.signerInfos[0];
  const tsaDigestOid = tsaSignerInfo.digestAlgorithm?.algorithmId || '';
  const tsaSigOid = tsaSignerInfo.signatureAlgorithm?.algorithmId || '';
  const tsaDigestAlg = ALLOWED_DIGEST_OIDS[tsaDigestOid];
  const tsaSigAlgName = ALLOWED_SIGNATURE_OIDS[tsaSigOid];

  if (!tsaDigestAlg || !tsaSigAlgName) {
    return buildHardInvalid(
      'TIMESTAMP_CRYPTO_CONSTRAINTS_FAILURE',
      `Algoritmo criptográfico da TSA não permitido (digest=${tsaDigestOid}, sig=${tsaSigOid}).`,
      { genTime },
    );
  }

  const tsaSignedAttrs = tsaSignerInfo.signedAttrs;
  if (
    !tsaSignedAttrs ||
    !Array.isArray(tsaSignedAttrs.attributes) ||
    tsaSignedAttrs.attributes.length === 0
  ) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      'TimeStampToken RFC 3161 não contém signedAttrs obrigatórios.',
      { genTime },
    );
  }

  // Verify contentType attribute in TSA signedAttrs == id-ct-TSTInfo
  const ctAttr = tsaSignedAttrs.attributes.find((a) => a.type === OID_CONTENT_TYPE);
  const ctValid =
    ctAttr?.values?.length === 1 &&
    ctAttr.values[0] instanceof asn1js.ObjectIdentifier &&
    ctAttr.values[0].valueBlock.toString() === OID_TST_INFO;
  if (!ctValid) {
    return buildHardInvalid(
      'TIMESTAMP_FORMAT_FAILURE',
      `Atributo assinado contentType da TSA inválido; esperado id-ct-TSTInfo (${OID_TST_INFO}).`,
      { genTime },
    );
  }

  // Verify messageDigest attribute in TSA signedAttrs == hash(tstInfoDer)
  const mdAttr = tsaSignedAttrs.attributes.find(
    (a) => a.type === OID_MESSAGE_DIGEST,
  );
  const calculatedTstInfoDigest = crypto
    .createHash(tsaDigestAlg.nodeAlg)
    .update(tstInfoDer)
    .digest();

  let tstDigestMatches = false;
  if (
    mdAttr?.values?.length === 1 &&
    mdAttr.values[0] instanceof asn1js.OctetString
  ) {
    const mdBytes = Buffer.from(mdAttr.values[0].valueBlock.valueHexView);
    if (mdBytes.length === calculatedTstInfoDigest.length) {
      tstDigestMatches = crypto.timingSafeEqual(mdBytes, calculatedTstInfoDigest);
    }
  }

  if (!tstDigestMatches) {
    return buildHardInvalid(
      'TIMESTAMP_SIGNATURE_INVALID',
      'O atributo messageDigest assinado pela TSA não corresponde ao conteúdo de TSTInfo.',
      { genTime, signatureValid: false },
    );
  }

  // Identify the exact TSA certificate associated with tsaSignerInfo.sid
  const resolvedTsaSigner = await resolveCmsSignerCertificate(
    signedData,
    tsaSignerInfo,
  );
  if (
    !resolvedTsaSigner.found ||
    !resolvedTsaSigner.certificate ||
    !resolvedTsaSigner.der
  ) {
    return buildHardInvalid(
      'TSA_CERTIFICATE_NOT_FOUND',
      resolvedTsaSigner.error ||
        'Certificado da TSA associado ao SignerInfo do carimbo de tempo não encontrado.',
      { genTime },
    );
  }

  const tsaCert = resolvedTsaSigner.certificate;
  const tsaCertDer = resolvedTsaSigner.der;
  const tsaNode = parseX509Node(tsaCertDer);

  // Verify mathematical signature of the TSA over tsaSignedAttrs
  let signatureValid = false;
  try {
    let signedAttrsBytes: ArrayBuffer;
    if (
      tsaSignedAttrs.encodedValue &&
      tsaSignedAttrs.encodedValue.byteLength > 0
    ) {
      const copy = Buffer.from(tsaSignedAttrs.encodedValue);
      copy[0] = 0x31; // EXPLICIT SET OF tag per RFC 5652 §5.4
      signedAttrsBytes = copy.buffer.slice(
        copy.byteOffset,
        copy.byteOffset + copy.byteLength,
      ) as ArrayBuffer;
    } else {
      const copy = Buffer.from(tsaSignedAttrs.toSchema().toBER(false));
      copy[0] = 0x31;
      signedAttrsBytes = copy.buffer.slice(
        copy.byteOffset,
        copy.byteOffset + copy.byteLength,
      ) as ArrayBuffer;
    }

    const engine = pkijs.getEngine();
    if (!engine?.crypto) {
      throw new Error('CryptoEngine pkijs indisponível.');
    }
    signatureValid = Boolean(
      await engine.crypto.verifyWithPublicKey(
        signedAttrsBytes,
        tsaSignerInfo.signature,
        tsaCert.subjectPublicKeyInfo,
        tsaSignerInfo.signatureAlgorithm,
        tsaDigestAlg.name,
      ),
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return buildHardInvalid(
      'TIMESTAMP_SIGNATURE_INVALID',
      'Assinatura criptográfica matemática da TSA no carimbo de tempo RFC 3161 é inválida.',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: false,
      },
    );
  }

  // Verify signingCertificate / signingCertificateV2 on TSA SignerInfo (if present)
  const tsaSigCertAttrCheck = verifyTsaSigningCertificateAttr(
    tsaSignedAttrs,
    tsaCertDer,
  );
  if (!tsaSigCertAttrCheck.valid) {
    return buildHardInvalid(
      'TSA_CERT_INCOMPATIBLE',
      tsaSigCertAttrCheck.error ||
        'Atributo signingCertificate/signingCertificateV2 da TSA inválido.',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
      },
    );
  }

  // Requirement 2: Verify TSTInfo.messageImprint against the stamped signature/content bytes
  const imprintAlgOid =
    tstInfo.messageImprint?.hashAlgorithm?.algorithmId || '';
  const imprintAlg = ALLOWED_DIGEST_OIDS[imprintAlgOid];
  if (!imprintAlg) {
    return buildHardInvalid(
      'TIMESTAMP_CRYPTO_CONSTRAINTS_FAILURE',
      `Algoritmo de hash do messageImprint RFC 3161 não permitido (${imprintAlgOid}).`,
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
      },
    );
  }

  const imprintHashBytes = Buffer.from(
    tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView,
  );
  const expectedImprintBytes = crypto
    .createHash(imprintAlg.nodeAlg)
    .update(params.stampedContentBytes)
    .digest();

  const messageImprintValid =
    imprintHashBytes.length === expectedImprintBytes.length &&
    crypto.timingSafeEqual(imprintHashBytes, expectedImprintBytes);

  if (!messageImprintValid) {
    return buildHardInvalid(
      'TIMESTAMP_MESSAGE_IMPRINT_MISMATCH',
      'O messageImprint do TSTInfo RFC 3161 diverge do hash calculado sobre a assinatura/conteúdo carimbado.',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
        messageImprintValid: false,
      },
    );
  }

  // Requirement 3 & 4 (RFC 3161 §2.3): Check TSA certificate compatibility & EKU id-kp-timeStamping (exclusive + critical = true)
  const hasBasicAndKeyUsageCompatibility =
    !tsaNode.basicConstraints.malformed &&
    !tsaNode.keyUsage.malformed &&
    !tsaNode.extendedKeyUsage.malformed &&
    !tsaNode.hasUnrecognizedCriticalExtension &&
    tsaNode.basicConstraints.cA === false &&
    tsaNode.keyUsage.present &&
    (tsaNode.keyUsage.digitalSignature || tsaNode.keyUsage.nonRepudiation) &&
    !tsaNode.keyUsage.keyCertSign &&
    genTime >= tsaNode.validFrom &&
    genTime <= tsaNode.validTo;

  const tsaExtendedKeyUsageCritical =
    tsaNode.extendedKeyUsage.present &&
    tsaNode.extendedKeyUsage.critical === true;

  const hasValidTimeStampingEku =
    tsaNode.extendedKeyUsage.present &&
    tsaNode.extendedKeyUsage.critical === true &&
    tsaNode.extendedKeyUsage.oids.length === 1 &&
    tsaNode.extendedKeyUsage.oids[0] === OID_KP_TIME_STAMPING;

  if (!hasBasicAndKeyUsageCompatibility) {
    return buildHardInvalid(
      'TSA_CERT_INCOMPATIBLE',
      'Certificado da TSA é incompatível (cA=true, KeyUsage inadequado ou genTime fora da janela de vigência da TSA).',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
        messageImprintValid: true,
        tsaKeyUsageValid: false,
        tsaExtendedKeyUsageValid: hasValidTimeStampingEku,
        tsaExtendedKeyUsageCritical,
      },
    );
  }

  if (!hasValidTimeStampingEku) {
    return buildHardInvalid(
      'TSA_EKU_INVALID',
      'Certificado da TSA não possui ExtendedKeyUsage crítico (critical = true) e exclusivo id-kp-timeStamping (1.3.6.1.5.5.7.3.8) conforme RFC 3161 §2.3.',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
        messageImprintValid: true,
        tsaKeyUsageValid: true,
        tsaExtendedKeyUsageValid: false,
        tsaExtendedKeyUsageCritical,
      },
    );
  }

  // Evaluate TSA X.509 Chain and Trust Anchors
  const effectiveTsaTrustedCerts =
    params.trustedTsaCerts && params.trustedTsaCerts.length > 0
      ? params.trustedTsaCerts
      : params.trustedTsaRootPems && params.trustedTsaRootPems.length > 0
        ? undefined
        : params.fallbackTrustedCerts;

  const effectiveTsaTrustedRootPems =
    params.trustedTsaRootPems && params.trustedTsaRootPems.length > 0
      ? params.trustedTsaRootPems
      : params.trustedTsaCerts && params.trustedTsaCerts.length > 0
        ? undefined
        : params.fallbackTrustedRootPems;

  const tsaChainEval = await evaluateX509ChainAndTrust({
    signerCert: tsaCert,
    cmsCertificates: [
      ...resolvedTsaSigner.cmsCertificates,
      ...(params.extraCandidateCerts || []),
    ],
    intermediateCerts: [
      ...(params.tsaIntermediateCerts || []),
      ...(params.intermediateCerts || []),
    ],
    intermediatePems: [
      ...(params.tsaIntermediatePems || []),
      ...(params.intermediatePems || []),
    ],
    trustedCerts: effectiveTsaTrustedCerts,
    trustedRootPems: effectiveTsaTrustedRootPems,
    allowCustomTrustAnchors: params.allowCustomTrustAnchors,
    purpose: 'TIMESTAMP_AUTHORITY',
  });

  const tsaChainStatus = tsaChainEval.chainValidation.status;

  if (tsaChainStatus === 'INVALID') {
    return buildHardInvalid(
      tsaChainEval.subIndication || 'TSA_CHAIN_INVALID',
      tsaChainEval.chainValidation.error ||
        'Cadeia de certificados da TSA inválida.',
      {
        genTime,
        tsaSignerSubject: tsaNode.subject,
        signatureValid: true,
        messageImprintValid: true,
        tsaKeyUsageValid: true,
        tsaExtendedKeyUsageValid: true,
        tsaExtendedKeyUsageCritical: true,
        tsaChainStatus: 'INVALID',
        tsaChainValid: false,
        tsaRootTrusted: false,
      },
    );
  }

  // If TSA chain is valid, verify that all CA certificates in the TSA chain were also valid at genTime
  if (tsaChainStatus === 'VALID') {
    for (const node of tsaChainEval.chainNodes) {
      if (genTime < node.validFrom || genTime > node.validTo) {
        return buildHardInvalid(
          'TSA_CERT_INCOMPATIBLE',
          `Certificado "${node.commonName}" na cadeia da TSA estava fora de vigência no instante genTime do carimbo.`,
          {
            genTime,
            tsaSignerSubject: tsaNode.subject,
            signatureValid: true,
            messageImprintValid: true,
            tsaKeyUsageValid: false,
            tsaExtendedKeyUsageValid: true,
            tsaExtendedKeyUsageCritical: true,
            tsaChainStatus: 'INVALID',
            tsaChainValid: false,
            tsaRootTrusted: false,
          },
        );
      }
    }
  }

  const tsaChainValid = tsaChainEval.chainValidation.valid;
  const tsaRootTrusted = tsaChainEval.rootTrust.trusted;
  let validAndTrusted = tsaChainValid && tsaRootTrusted;

  // Lote 6F.2C: TSA chain revocation (TSA signer + TSA intermediates; trust anchor excluded by policy).
  // Only evaluated over a chain already proven valid up to a trusted anchor, so forged
  // CRL/OCSP signed by an untrusted key can never be accepted as evidence.
  let tsaRevocationChecked = false;
  let tsaRevocationComplete = false;
  let tsaRevocationSummaries: CertificateRevocationCheckSummary[] | undefined;
  let tsaRevocationSubIndication: string | undefined;
  let tsaRevocationError: string | undefined;
  let tsaRevoked = false;

  if (validAndTrusted && params.revocationOptions) {
    const tsaVerificationTime = params.verificationTime ?? new Date();
    const tsaRevEval = await evaluateTsaChainRevocation({
      tsaChainNodes: tsaChainEval.chainNodes,
      genTime,
      verificationTime: tsaVerificationTime,
      // 6F.2D: evidência buscada na rede para a cadeia da TSA, já validada até a âncora.
      options: await withOnlineRevocationEvidence(
        params.revocationOptions,
        tsaChainEval.chainNodes,
        tsaVerificationTime,
      ),
    });
    tsaRevocationChecked = tsaRevEval.revocationChecked;
    tsaRevocationComplete = tsaRevEval.trustComplete;
    tsaRevocationSummaries =
      tsaRevEval.certificateResults.length > 0
        ? tsaRevEval.certificateResults
        : undefined;
    tsaRevocationSubIndication = tsaRevEval.subIndication;
    tsaRevocationError = tsaRevEval.error;
    tsaRevoked = tsaRevEval.isRevoked;
  }

  if (tsaRevoked) {
    // A revoked/suspended TSA (or TSA CA) cannot provide a trusted POE. This does NOT make the
    // document signature INVALID by itself; the timestamp simply stops counting as POE.
    validAndTrusted = false;
  }

  const tsaTrustComplete =
    validAndTrusted && tsaRevocationChecked && tsaRevocationComplete;

  let subIndication: string | undefined;
  let error: string | undefined;
  if (tsaRevoked) {
    subIndication = tsaRevocationSubIndication || 'TSA_REVOKED';
    error =
      tsaRevocationError ||
      'Certificado da cadeia da TSA revogado ou suspenso; o carimbo não constitui POE confiável.';
  } else if (!validAndTrusted) {
    if (tsaChainStatus === 'INCOMPLETE_CHAIN') {
      subIndication = 'TSA_CHAIN_INCOMPLETE';
      error =
        tsaChainEval.chainValidation.error ||
        'Cadeia de certificados da TSA incompleta.';
    } else if (tsaChainStatus === 'UNTRUSTED_ROOT') {
      subIndication = 'TSA_ROOT_UNTRUSTED';
      error =
        tsaChainEval.rootTrust.error ||
        'A raiz da TSA não faz parte das âncoras de confiança autorizadas.';
    } else if (tsaChainStatus === 'SELF_SIGNED') {
      subIndication = 'TSA_SELF_SIGNED';
      error =
        'Certificado da TSA é autoassinado e não possui cadeia de confiança autorizada.';
    }
  }

  return {
    sourceKind: params.sourceKind,
    validAndTrusted,
    isHardInvalid: false,
    signatureValid: true,
    messageImprintValid: true,
    genTime,
    tsaSignerSubject: tsaNode.subject,
    tsaKeyUsageValid: true,
    tsaExtendedKeyUsageValid: true,
    tsaExtendedKeyUsageCritical: true,
    tsaChainStatus,
    tsaChainValid,
    tsaRootTrusted,
    tsaRevocationChecked,
    tsaTrustComplete,
    tsaRevocationSummaries,
    subIndication,
    error,
  };
}

/**
 * Internal helper that computes the canonical HMAC-SHA256 over an independent
 * external POE receipt record (`evidenceRecordId | sourceId | targetType | targetHashHex | poeTime`).
 */
function computeExternalPoeReceiptMac(
  evidence: Omit<ExternalPoeEvidence, 'authenticator'>,
  secretKey: string,
): string {
  const canonicalPayload = [
    evidence.evidenceRecordId.trim(),
    evidence.sourceId.trim(),
    evidence.targetType,
    evidence.targetHashHex.trim().toLowerCase(),
    evidence.poeTime.toISOString(),
  ].join('|');
  return crypto
    .createHmac('sha256', secretKey)
    .update(canonicalPayload, 'utf8')
    .digest('hex');
}

/**
 * Test-only helper for constructing synthetic pre-existing external POE receipts in unit tests.
 *
 * SECURITY GUARD (Lote 6F.2B):
 * Throws in production (`NODE_ENV === 'production'`) so backend production code can NEVER use
 * this function to self-authenticate an arbitrary caller-supplied date.
 */
export function computeExternalPoeReceiptMacForTest(
  evidence: Omit<ExternalPoeEvidence, 'authenticator'>,
  secretKey: string,
): string {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'computeExternalPoeReceiptMacForTest é restrito a testes e não pode ser utilizado em produção para autenticar datas arbitrárias.',
    );
  }
  return computeExternalPoeReceiptMac(evidence, secretKey);
}

export interface ExternalPoeValidationResult {
  valid: boolean;
  poeTime?: Date;
  subIndication?: string;
  error?: string;
}

/**
 * Requirements 6 & 7: Validates an ExternalPoeEvidence record.
 *
 * Distinguishes authentication of a caller declaration from an independent Proof of Existence (POE):
 * - Never falls back to `process.env.EXTERNAL_POE_HMAC_KEY` (preventing backend self-minting).
 * - Requires an independent pre-existing record identifier (`evidenceRecordId`).
 * - Rejects `poeTime > verificationTime`.
 * - Verifies `targetHashHex` against the actual cryptographic hash of the artifact being verified.
 * - Verifies authenticity via an independent `externalPoeVerifier` lookup/callback or an explicit
 *   verification secret (`externalPoeHmacKey`) bound to `evidenceRecordId`.
 */
export async function validateExternalPoeEvidence(params: {
  externalPoe: ExternalPoeEvidence;
  signedPdfSha256Hex: string;
  signatureValueSha256Hex: string;
  documentHashSha256Hex: string;
  verificationTime: Date;
  externalPoeHmacKey?: string;
  externalPoeVerifier?: (
    evidence: ExternalPoeEvidence,
    expectedTargetHashHex: string,
  ) => boolean | Promise<boolean>;
  trustedExternalPoeSources?: string[];
}): Promise<ExternalPoeValidationResult> {
  const { externalPoe } = params;

  if (
    !externalPoe ||
    typeof externalPoe !== 'object' ||
    typeof externalPoe.sourceId !== 'string' ||
    externalPoe.sourceId.trim().length === 0
  ) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error: 'POE externa sem identificador de origem (sourceId) válido.',
    };
  }

  if (
    typeof externalPoe.evidenceRecordId !== 'string' ||
    externalPoe.evidenceRecordId.trim().length === 0
  ) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error:
        'POE externa sem identificador de registro independente (evidenceRecordId); uma data declarada não constitui POE.',
    };
  }

  const allowedSources = params.trustedExternalPoeSources
    ? new Set(params.trustedExternalPoeSources)
    : DEFAULT_TRUSTED_EXTERNAL_POE_SOURCES;

  if (!allowedSources.has(externalPoe.sourceId.trim())) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error: `Origem de POE externa ("${externalPoe.sourceId}") não autorizada.`,
    };
  }

  if (
    !(externalPoe.poeTime instanceof Date) ||
    Number.isNaN(externalPoe.poeTime.getTime())
  ) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error: 'Data poeTime inválida na POE externa.',
    };
  }

  if (externalPoe.poeTime > params.verificationTime) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error:
        'A data poeTime da POE externa é posterior ao instante de verificação (verificationTime).',
    };
  }

  // Requirement 7: Verify targetHashHex matches the actual artifact being verified BEFORE or DURING provenance check
  let expectedTargetHashHex = '';
  if (externalPoe.targetType === 'SIGNED_PDF_SHA256') {
    expectedTargetHashHex = params.signedPdfSha256Hex;
  } else if (externalPoe.targetType === 'SIGNATURE_VALUE_SHA256') {
    expectedTargetHashHex = params.signatureValueSha256Hex;
  } else if (externalPoe.targetType === 'DOCUMENT_HASH_SHA256') {
    expectedTargetHashHex = params.documentHashSha256Hex;
  } else {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_HASH_MISMATCH',
      error: `Tipo de alvo de POE externa desconhecido (${String(externalPoe.targetType)}).`,
    };
  }

  // Verify independent provenance via externalPoeVerifier callback and/or explicit externalPoeHmacKey
  // NOTE: Never fall back to process.env.EXTERNAL_POE_HMAC_KEY so backend callers cannot self-mint trusted POEs.
  const hasVerifierCallback = typeof params.externalPoeVerifier === 'function';
  const hmacKey = params.externalPoeHmacKey || '';

  if (!hasVerifierCallback && !hmacKey) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
      error:
        'POE externa sem verificador independente (externalPoeVerifier) ou chave de verificação explícita.',
    };
  }

  if (hmacKey) {
    if (
      typeof externalPoe.authenticator !== 'string' ||
      externalPoe.authenticator.trim().length === 0
    ) {
      return {
        valid: false,
        subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
        error: 'POE externa sem autenticador criptográfico (authenticator).',
      };
    }

    const expectedAuthenticator = computeExternalPoeReceiptMac(
      externalPoe,
      hmacKey,
    );
    if (
      !timingSafeEqualStr(
        externalPoe.authenticator.trim().toLowerCase(),
        expectedAuthenticator.toLowerCase(),
      )
    ) {
      return {
        valid: false,
        subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
        error:
          'Autenticador criptográfico (HMAC) da POE externa inválido para o registro, origem e artefato informados.',
      };
    }
  }

  if (hasVerifierCallback) {
    let verifiedByCallback = false;
    try {
      verifiedByCallback = Boolean(
        await params.externalPoeVerifier!(externalPoe, expectedTargetHashHex),
      );
    } catch {
      verifiedByCallback = false;
    }
    if (!verifiedByCallback) {
      return {
        valid: false,
        subIndication: 'EXTERNAL_POE_UNAUTHENTICATED',
        error:
          'Registro de POE externa rejeitado pelo verificador independente (externalPoeVerifier).',
      };
    }
  }

  const providedHash = (externalPoe.targetHashHex || '').trim().toLowerCase();
  if (
    !providedHash ||
    !timingSafeEqualStr(providedHash, expectedTargetHashHex.toLowerCase())
  ) {
    return {
      valid: false,
      subIndication: 'EXTERNAL_POE_HASH_MISMATCH',
      error:
        'O hash (targetHashHex) vinculado à POE externa diverge do hash real do documento/assinatura verificado.',
    };
  }

  return {
    valid: true,
    poeTime: externalPoe.poeTime,
  };
}

export interface EvaluateTemporalAndPoeParams {
  pdfBuffer: Buffer;
  primarySignerInfo: pkijs.SignerInfo;
  primarySignatureEntry: PdfSignatureRevisionSummary;
  allSignatureEntries: PdfSignatureRevisionSummary[];
  primaryCmsCertificates: pkijs.Certificate[];
  signerChainNodes: ParsedX509Node[];
  claimedSigningTime?: Date;
  verificationTime: Date;
  options: PadesVerificationOptions;
  calculatedDigestHex: string;
}

/**
 * Evaluates temporal validity and Proof of Existence (POE) for Lote 6F.2B,
 * following ETSI EN 319 102-1 and RFC 3161.
 */
export async function evaluateTemporalValidityAndPoe(
  params: EvaluateTemporalAndPoeParams,
): Promise<PadesTemporalValidityResult> {
  const {
    pdfBuffer,
    primarySignerInfo,
    primarySignatureEntry,
    allSignatureEntries,
    primaryCmsCertificates,
    signerChainNodes,
    claimedSigningTime,
    verificationTime,
    options,
    calculatedDigestHex,
  } = params;

  const signerNode = signerChainNodes[0];
  const validationContext = options.validationContext ?? 'VERIFICATION';
  const currentlyValid =
    verificationTime >= signerNode.validFrom &&
    verificationTime <= signerNode.validTo;

  // 1. Check if claimedSigningTime is self-contradictory (outside signer's validity window)
  if (
    claimedSigningTime &&
    (claimedSigningTime < signerNode.validFrom ||
      claimedSigningTime > signerNode.validTo)
  ) {
    return {
      status: 'CLAIMED_TIME_OUTSIDE_VALIDITY',
      valid: false,
      currentlyValid,
      hasTrustedPoe: false,
      poeSource: 'NONE',
      claimedSigningTime,
      verificationTime,
      subIndication: 'CLAIMED_TIME_OUTSIDE_VALIDITY',
      error:
        'O atributo signingTime declarado pelo signatário está fora da janela de validade do certificado.',
    };
  }

  // 2. Collect RFC 3161 Timestamp Tokens (signatureTimeStampToken in unsignedAttrs + /DocTimeStamp revisions)
  const signatureValueBytes = Buffer.from(
    primarySignerInfo.signature.valueBlock.valueHexView,
  );

  const unsignedAttrs = primarySignerInfo.unsignedAttrs?.attributes || [];
  const sigTsAttrs = unsignedAttrs.filter(
    (a) => a.type === OID_SIGNATURE_TIME_STAMP_TOKEN,
  );

  const docTsEntries = allSignatureEntries.filter(
    (s) =>
      s.type === 'DocTimeStamp' &&
      s.revisionEndByte > primarySignatureEntry.revisionEndByte &&
      s.cmsDerBytes &&
      s.signedContentBytes,
  );

  let timestampPresent = false;
  let lastTsDiag: Partial<PadesTemporalValidityResult> = {};
  let untrustedTsSubIndication: string | undefined;
  let untrustedTsError: string | undefined;

  const trustedPoeCandidates: Array<{
    poeTime: Date;
    poeSource:
      | 'RFC3161_SIGNATURE_TIMESTAMP'
      | 'RFC3161_DOC_TIMESTAMP'
      | 'EXTERNAL_POE';
    diag: Partial<PadesTemporalValidityResult>;
  }> = [];

  // 2A. Validate signatureTimeStampToken attributes
  for (const attr of sigTsAttrs) {
    timestampPresent = true;
    if (!attr.values || attr.values.length === 0) {
      return {
        status: 'INVALID_TIMESTAMP',
        valid: false,
        currentlyValid,
        hasTrustedPoe: false,
        poeSource: 'NONE',
        claimedSigningTime,
        verificationTime,
        timestampPresent: true,
        timestampSignatureValid: false,
        timestampMessageImprintValid: false,
        subIndication: 'TIMESTAMP_FORMAT_FAILURE',
        error: 'Atributo signatureTimeStampToken vazio em unsignedAttrs.',
      };
    }

    for (const val of attr.values) {
      let tokenDer: Buffer;
      try {
        tokenDer = Buffer.from(val.toBER(false));
      } catch {
        return {
          status: 'INVALID_TIMESTAMP',
          valid: false,
          currentlyValid,
          hasTrustedPoe: false,
          poeSource: 'NONE',
          claimedSigningTime,
          verificationTime,
          timestampPresent: true,
          timestampSignatureValid: false,
          timestampMessageImprintValid: false,
          subIndication: 'TIMESTAMP_FORMAT_FAILURE',
          error: 'Falha ao serializar ASN.1 de signatureTimeStampToken.',
        };
      }

      const tsRes = await validateRfc3161TimestampToken({
        tokenDer,
        stampedContentBytes: signatureValueBytes,
        sourceKind: 'RFC3161_SIGNATURE_TIMESTAMP',
        extraCandidateCerts: primaryCmsCertificates,
        trustedTsaCerts: options.trustedTsaCerts,
        trustedTsaRootPems: options.trustedTsaRootPems,
        fallbackTrustedCerts: options.trustedCerts,
        fallbackTrustedRootPems: options.trustedRootPems,
        intermediateCerts: options.intermediateCerts,
        intermediatePems: options.intermediatePems,
        tsaIntermediateCerts: options.tsaIntermediateCerts,
        tsaIntermediatePems: options.tsaIntermediatePems,
        allowCustomTrustAnchors: options.allowCustomTrustAnchors,
        revocationOptions: options,
        verificationTime,
      });

      const diag: Partial<PadesTemporalValidityResult> = {
        timestampPresent: true,
        timestampSignatureValid: tsRes.signatureValid,
        timestampMessageImprintValid: tsRes.messageImprintValid,
        timestampGenTime: tsRes.genTime,
        tsaSignerSubject: tsRes.tsaSignerSubject,
        tsaKeyUsageValid: tsRes.tsaKeyUsageValid,
        tsaExtendedKeyUsageValid: tsRes.tsaExtendedKeyUsageValid,
        tsaExtendedKeyUsageCritical: tsRes.tsaExtendedKeyUsageCritical,
        tsaChainStatus: tsRes.tsaChainStatus,
        tsaChainValid: tsRes.tsaChainValid,
        tsaRootTrusted: tsRes.tsaRootTrusted,
        tsaRevocationChecked: tsRes.tsaRevocationChecked,
        tsaTrustComplete: tsRes.tsaTrustComplete,
        tsaRevocationSummaries: tsRes.tsaRevocationSummaries,
      };
      lastTsDiag = diag;

      if (tsRes.isHardInvalid) {
        return {
          status: 'INVALID_TIMESTAMP',
          valid: false,
          currentlyValid,
          hasTrustedPoe: false,
          poeSource: 'NONE',
          claimedSigningTime,
          verificationTime,
          ...diag,
          subIndication: tsRes.subIndication || 'INVALID_TIMESTAMP',
          error: tsRes.error,
        };
      }

      if (tsRes.validAndTrusted && tsRes.genTime) {
        trustedPoeCandidates.push({
          poeTime: tsRes.genTime,
          poeSource: 'RFC3161_SIGNATURE_TIMESTAMP',
          diag,
        });
      } else {
        untrustedTsSubIndication = tsRes.subIndication || 'TSA_UNTRUSTED';
        untrustedTsError = tsRes.error;
      }
    }
  }

  // 2B. Validate /DocTimeStamp revisions
  for (const docTs of docTsEntries) {
    timestampPresent = true;
    const tsRes = await validateRfc3161TimestampToken({
      tokenDer: docTs.cmsDerBytes!,
      stampedContentBytes: docTs.signedContentBytes!,
      sourceKind: 'RFC3161_DOC_TIMESTAMP',
      extraCandidateCerts: primaryCmsCertificates,
      trustedTsaCerts: options.trustedTsaCerts,
      trustedTsaRootPems: options.trustedTsaRootPems,
      fallbackTrustedCerts: options.trustedCerts,
      fallbackTrustedRootPems: options.trustedRootPems,
      intermediateCerts: options.intermediateCerts,
      intermediatePems: options.intermediatePems,
      tsaIntermediateCerts: options.tsaIntermediateCerts,
      tsaIntermediatePems: options.tsaIntermediatePems,
      allowCustomTrustAnchors: options.allowCustomTrustAnchors,
      revocationOptions: options,
      verificationTime,
    });

    const diag: Partial<PadesTemporalValidityResult> = {
      timestampPresent: true,
      timestampSignatureValid: tsRes.signatureValid,
      timestampMessageImprintValid: tsRes.messageImprintValid,
      timestampGenTime: tsRes.genTime,
      tsaSignerSubject: tsRes.tsaSignerSubject,
      tsaKeyUsageValid: tsRes.tsaKeyUsageValid,
      tsaExtendedKeyUsageValid: tsRes.tsaExtendedKeyUsageValid,
      tsaExtendedKeyUsageCritical: tsRes.tsaExtendedKeyUsageCritical,
      tsaChainStatus: tsRes.tsaChainStatus,
      tsaChainValid: tsRes.tsaChainValid,
      tsaRootTrusted: tsRes.tsaRootTrusted,
      tsaRevocationChecked: tsRes.tsaRevocationChecked,
      tsaTrustComplete: tsRes.tsaTrustComplete,
      tsaRevocationSummaries: tsRes.tsaRevocationSummaries,
    };
    lastTsDiag = diag;

    if (tsRes.isHardInvalid) {
      return {
        status: 'INVALID_TIMESTAMP',
        valid: false,
        currentlyValid,
        hasTrustedPoe: false,
        poeSource: 'NONE',
        claimedSigningTime,
        verificationTime,
        ...diag,
        subIndication: tsRes.subIndication || 'INVALID_TIMESTAMP',
        error: tsRes.error,
      };
    }

    if (tsRes.validAndTrusted && tsRes.genTime) {
      trustedPoeCandidates.push({
        poeTime: tsRes.genTime,
        poeSource: 'RFC3161_DOC_TIMESTAMP',
        diag,
      });
    } else {
      untrustedTsSubIndication = tsRes.subIndication || 'TSA_UNTRUSTED';
      untrustedTsError = tsRes.error;
    }
  }

  // 3. Validate External POE (Requirements 6 & 7)
  // Reject bare unauthenticated `(options as { poeTime?: Date }).poeTime`
  const rawUnauthenticatedPoeTime = (options as { poeTime?: unknown }).poeTime;
  let externalPoeDiag: Partial<PadesTemporalValidityResult> = {};
  let externalPoeFailureSubIndication: string | undefined;
  let externalPoeFailureError: string | undefined;

  if (options.externalPoe !== undefined) {
    const signedPdfSha256Hex = crypto
      .createHash('sha256')
      .update(pdfBuffer)
      .digest('hex');
    const signatureValueSha256Hex = crypto
      .createHash('sha256')
      .update(signatureValueBytes)
      .digest('hex');

    const extCheck = await validateExternalPoeEvidence({
      externalPoe: options.externalPoe,
      signedPdfSha256Hex,
      signatureValueSha256Hex,
      documentHashSha256Hex: calculatedDigestHex,
      verificationTime,
      externalPoeHmacKey: options.externalPoeHmacKey,
      externalPoeVerifier: options.externalPoeVerifier,
      trustedExternalPoeSources: options.trustedExternalPoeSources,
    });

    externalPoeDiag = { externalPoeValid: extCheck.valid };

    if (extCheck.valid && extCheck.poeTime) {
      trustedPoeCandidates.push({
        poeTime: extCheck.poeTime,
        poeSource: 'EXTERNAL_POE',
        diag: {
          ...lastTsDiag,
          externalPoeValid: true,
        },
      });
    } else {
      externalPoeFailureSubIndication =
        extCheck.subIndication || 'EXTERNAL_POE_UNAUTHENTICATED';
      externalPoeFailureError = extCheck.error;
    }
  } else if (rawUnauthenticatedPoeTime !== undefined) {
    // Requirement 6: Bare options.poeTime is never accepted as trusted POE
    externalPoeDiag = { externalPoeValid: false };
    externalPoeFailureSubIndication = 'EXTERNAL_POE_UNAUTHENTICATED';
    externalPoeFailureError =
      'O parâmetro bruto poeTime não é aceito como prova confiável de existência sem evidência autenticada (externalPoe).';
  }

  // 4. If we have at least one trusted POE, evaluate the earliest trusted POE against signer validity
  if (trustedPoeCandidates.length > 0) {
    // 6F.2C-R: entre POEs confiáveis, prefere as completas (TSA com revogação comprovada ou POE
    // externa autenticada); só então a mais antiga. Uma POE incompleta mais antiga não pode
    // esconder uma completa posterior.
    const isComplete = (c: (typeof trustedPoeCandidates)[number]) =>
      c.poeSource === 'EXTERNAL_POE' || c.diag.tsaTrustComplete === true;
    trustedPoeCandidates.sort(
      (a, b) =>
        Number(isComplete(b)) - Number(isComplete(a)) ||
        a.poeTime.getTime() - b.poeTime.getTime(),
    );
    const bestPoe = trustedPoeCandidates[0];
    const poeTime = bestPoe.poeTime;

    // Fundamental Temporal Rule (ETSI EN 319 102-1):
    // A POE at `poeTime` proves an upper bound (`t_creation <= poeTime`): the signature already existed by `poeTime`.
    // - If poeTime < validFrom: proves `t_creation <= poeTime < validFrom` (signature existed BEFORE the certificate became valid) -> NOT_YET_VALID (INVALID).
    if (poeTime < signerNode.validFrom) {
      return {
        status: 'NOT_YET_VALID',
        valid: false,
        currentlyValid,
        hasTrustedPoe: true,
        provenExistedBeforeExpiration: true,
        exactCreationTimeProven: false,
        lowerBoundAfterNotBeforeProven: false,
        poeSource: bestPoe.poeSource,
        poeTime,
        claimedSigningTime,
        verificationTime,
        ...bestPoe.diag,
        ...externalPoeDiag,
        subIndication: 'POE_BEFORE_NOT_BEFORE',
        error:
          'A prova de existência (POE) demonstra que a assinatura já existia antes do início da vigência (notBefore) do certificado do signatário.',
      };
    }

    // - If poeTime > validTo: POE after expiration proves `t_creation <= poeTime`, which does NOT prove the signature was created after expiration -> OUT_OF_BOUNDS_AT_POE (INDETERMINATE).
    if (poeTime > signerNode.validTo) {
      return {
        status: 'OUT_OF_BOUNDS_AT_POE',
        valid: false,
        currentlyValid,
        hasTrustedPoe: true,
        provenExistedBeforeExpiration: false,
        exactCreationTimeProven: false,
        lowerBoundAfterNotBeforeProven: false,
        poeSource: bestPoe.poeSource,
        poeTime,
        claimedSigningTime,
        verificationTime,
        ...bestPoe.diag,
        ...externalPoeDiag,
        subIndication: 'OUT_OF_BOUNDS_AT_POE',
        error:
          'O carimbo de tempo / POE é posterior ao vencimento (notAfter) do certificado do signatário; sem evidência temporal anterior ao vencimento, o resultado permanece INDETERMINATE.',
      };
    }

    // Also verify all certificates in the signer's chain at poeTime
    for (const chainCert of signerChainNodes.slice(1)) {
      if (poeTime < chainCert.validFrom) {
        return {
          status: 'NOT_YET_VALID',
          valid: false,
          currentlyValid,
          hasTrustedPoe: true,
          provenExistedBeforeExpiration: true,
          exactCreationTimeProven: false,
          lowerBoundAfterNotBeforeProven: false,
          poeSource: bestPoe.poeSource,
          poeTime,
          claimedSigningTime,
          verificationTime,
          ...bestPoe.diag,
          ...externalPoeDiag,
          subIndication: 'POE_BEFORE_NOT_BEFORE',
          error: `A POE é anterior ao início da vigência do certificado emissor "${chainCert.commonName}".`,
        };
      }
      if (poeTime > chainCert.validTo) {
        return {
          status: 'OUT_OF_BOUNDS_AT_POE',
          valid: false,
          currentlyValid,
          hasTrustedPoe: true,
          provenExistedBeforeExpiration: false,
          exactCreationTimeProven: false,
          lowerBoundAfterNotBeforeProven: false,
          poeSource: bestPoe.poeSource,
          poeTime,
          claimedSigningTime,
          verificationTime,
          ...bestPoe.diag,
          ...externalPoeDiag,
          subIndication: 'OUT_OF_BOUNDS_AT_POE',
          error: `A POE é posterior ao vencimento do certificado emissor "${chainCert.commonName}".`,
        };
      }
    }

    // `notBefore <= poeTime <= notAfter`:
    // Proves the signature already existed by `poeTime` (before expiration `notAfter`),
    // without claiming `t_creation == poeTime` (`exactCreationTimeProven = false`) or
    // proving a lower bound after `notBefore` (`lowerBoundAfterNotBeforeProven = false`).
    return {
      status: 'VALID_AT_POE',
      valid: true,
      currentlyValid,
      hasTrustedPoe: true,
      provenExistedBeforeExpiration: true,
      exactCreationTimeProven: false,
      lowerBoundAfterNotBeforeProven: false,
      poeSource: bestPoe.poeSource,
      poeTime,
      claimedSigningTime,
      verificationTime,
      ...bestPoe.diag,
      ...externalPoeDiag,
    };
  }

  // 5. No trusted POE available (either no timestamp/POE, or TSA chain untrusted/incomplete, or externalPoe unauthenticated/mismatched)
  const combinedDiag = {
    ...lastTsDiag,
    ...externalPoeDiag,
    ...(timestampPresent ? { timestampPresent: true } : {}),
  };
  const specificFailureSubIndication =
    untrustedTsSubIndication || externalPoeFailureSubIndication;
  const specificFailureError = untrustedTsError || externalPoeFailureError;

  // If a timestamp or externalPoe was explicitly supplied and failed trust/authentication/hash binding,
  // temporal validity cannot be considered satisfied by wall-clock alone.
  if (specificFailureSubIndication) {
    const statusWhenPoeRejected: PadesTemporalValidityResult['status'] =
      verificationTime > signerNode.validTo
        ? 'OUT_OF_BOUNDS_NO_POE'
        : verificationTime < signerNode.validFrom
          ? 'NOT_YET_VALID'
          : 'OUT_OF_BOUNDS_NO_POE';

    return {
      status: statusWhenPoeRejected,
      valid: false,
      currentlyValid,
      hasTrustedPoe: false,
      poeSource: 'NONE',
      claimedSigningTime,
      verificationTime,
      ...combinedDiag,
      subIndication: specificFailureSubIndication,
      error:
        specificFailureError ||
        'A prova temporal fornecida não pôde ser validada até uma origem/TSA confiável.',
    };
  }

  if (verificationTime < signerNode.validFrom) {
    return {
      status: 'NOT_YET_VALID',
      valid: false,
      currentlyValid: false,
      hasTrustedPoe: false,
      poeSource: 'NONE',
      claimedSigningTime,
      verificationTime,
      ...combinedDiag,
      subIndication: 'NOT_YET_VALID',
      error: 'O certificado do signatário ainda não entrou em vigência.',
    };
  }

  if (verificationTime > signerNode.validTo) {
    if (validationContext === 'LIVE_ISSUANCE') {
      return {
        status: 'EXPIRED_AT_ISSUANCE',
        valid: false,
        currentlyValid: false,
        hasTrustedPoe: false,
        poeSource: 'NONE',
        claimedSigningTime,
        verificationTime,
        ...combinedDiag,
        subIndication: 'EXPIRED_AT_ISSUANCE',
        error: 'O certificado do signatário está expirado no momento da emissão.',
      };
    }

    return {
      status: 'OUT_OF_BOUNDS_NO_POE',
      valid: false,
      currentlyValid: false,
      hasTrustedPoe: false,
      poeSource: 'NONE',
      claimedSigningTime,
      verificationTime,
      ...combinedDiag,
      subIndication: 'OUT_OF_BOUNDS_NO_POE',
      error:
        'Certificado expirado no instante da verificação e sem prova confiável de existência (POE) anterior ao vencimento.',
    };
  }

  return {
    status: 'WITHIN_CURRENT_VALIDITY_NO_TIMESTAMP',
    valid: true,
    currentlyValid: true,
    hasTrustedPoe: false,
    poeSource: 'NONE',
    claimedSigningTime,
    verificationTime,
    ...combinedDiag,
  };
}
