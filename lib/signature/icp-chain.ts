import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import {
  ICP_BRASIL_INTERMEDIATES,
  ICP_BRASIL_ROOTS,
} from './icp-brasil-certs.ts';
import { extractCpfFromCertificate } from './crypto-utils.ts';
import type {
  PadesChainValidationResult,
  PadesRootTrustResult,
  PadesSignerIdentityResult,
} from './types.ts';

// Garante motor WebCrypto para pkijs
try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine já configurada
}

export type IcpChainCheck = {
  // A cadeia fecha numa raiz ICP-Brasil fixada, com todos os elos válidos na data.
  valid: boolean;
  // Nomes (CN) do signatário até a raiz, quando a cadeia foi montada.
  path: string[];
  error?: string;
};

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXTENDED_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_ICP_BRASIL_PF_DATA = '2.16.76.1.3.1';

const RECOGNIZED_CRITICAL_EXTENSION_OIDS = new Set<string>([
  OID_BASIC_CONSTRAINTS,
  OID_KEY_USAGE,
  OID_EXTENDED_KEY_USAGE,
  OID_SUBJECT_KEY_IDENTIFIER,
  OID_AUTHORITY_KEY_IDENTIFIER,
  OID_SUBJECT_ALT_NAME,
  '2.5.29.32', // CertificatePolicies
  '2.5.29.30', // NameConstraints
  '2.5.29.31', // CRLDistributionPoints
  '2.5.29.54', // InhibitAnyPolicy
  '2.5.29.36', // PolicyConstraints
]);

/**
 * ExtendedKeyUsage OIDs compatible with document / e-CPF digital signature.
 * Certificates restricted solely to serverAuth (1.3.6.1.5.5.7.3.1),
 * timeStamping (1.3.6.1.5.5.7.3.8) or OCSPSigning (1.3.6.1.5.5.7.3.9)
 * are rejected for PAdES document signing.
 */
const ALLOWED_DOCUMENT_SIGNING_EKU_OIDS = new Set<string>([
  '2.5.29.37.0', // anyExtendedKeyUsage
  '1.3.6.1.5.5.7.3.2', // id-kp-clientAuth (padrão ICP-Brasil e-CPF)
  '1.3.6.1.5.5.7.3.4', // id-kp-emailProtection (padrão ICP-Brasil e-CPF)
  '1.3.6.1.5.5.7.3.3', // id-kp-codeSigning
  '1.2.840.113583.1.1.5', // Adobe Authentic Documents Trust
  '1.3.6.1.4.1.311.10.3.12', // szOID_KP_DOCUMENT_SIGNING (Microsoft)
  '0.4.0.2231.3.0', // ETSI TSL Signing
  '1.3.6.1.5.5.7.3.36', // id-kp-documentSigning (RFC 9336)
]);

const MAX_CHAIN_LENGTH = 16;

function parse(der: Buffer): pkijs.Certificate {
  const asn1 = asn1js.fromBER(
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
  );
  if (!asn1.result || asn1.offset === -1) {
    throw new Error('Falha ao decodificar ASN.1 do certificado X.509.');
  }
  return new pkijs.Certificate({ schema: asn1.result });
}

let cache: { roots: pkijs.Certificate[]; intermediates: pkijs.Certificate[] } | null =
  null;
function bundle() {
  cache ??= {
    roots: ICP_BRASIL_ROOTS.map((r) => parse(Buffer.from(r.der, 'base64'))),
    intermediates: ICP_BRASIL_INTERMEDIATES.map((d) => parse(Buffer.from(d, 'base64'))),
  };
  return cache;
}

function commonName(cert: pkijs.Certificate): string {
  const cn = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3');
  return cn ? String(cn.value.valueBlock.value) : 'Sem nome';
}

/**
 * Valida a cadeia do certificado do signatário até uma raiz ICP-Brasil fixada,
 * na data informada (a data da assinatura). Não consulta revogação (LCR/OCSP).
 */
export async function validateIcpChain(
  signer: pkijs.Certificate,
  at: Date,
  extraCerts: pkijs.Certificate[] = [],
): Promise<IcpChainCheck> {
  const { roots, intermediates } = bundle();
  // O pkijs remove duplicados e usa o ÚLTIMO certificado da lista como o que será
  // validado; o signatário não pode aparecer antes dele.
  const signerDer = Buffer.from(signer.tbsView);
  const others = [...intermediates, ...extraCerts].filter(
    (c) => !Buffer.from(c.tbsView).equals(signerDer),
  );
  try {
    const engine = new pkijs.CertificateChainValidationEngine({
      trustedCerts: roots,
      certs: [...others, signer],
      checkDate: at,
    });
    const result = await engine.verify();
    const path = (result.certificatePath || []).map(commonName);
    // Defesa extra: o caminho validado precisa começar no próprio signatário.
    const first = result.certificatePath?.[0];
    if (
      result.result &&
      (!first ||
        !first.serialNumber.isEqual(signer.serialNumber) ||
        commonName(first) !== commonName(signer))
    )
      return {
        valid: false,
        path,
        error: 'A cadeia validada não corresponde ao certificado do signatário.',
      };
    if (!result.result)
      return {
        valid: false,
        path,
        error:
          result.resultMessage ||
          'O certificado não pertence a uma cadeia ICP-Brasil reconhecida.',
      };
    return { valid: true, path };
  } catch (e) {
    const message =
      (e as { resultMessage?: string; message?: string })?.resultMessage ||
      (e as { message?: string })?.message;
    return {
      valid: false,
      path: [],
      error: message || 'O certificado não pertence a uma cadeia ICP-Brasil reconhecida.',
    };
  }
}

export interface ParsedBasicConstraints {
  present: boolean;
  critical: boolean;
  cA: boolean;
  pathLenConstraint: number | null;
  malformed: boolean;
}

export interface ParsedKeyUsage {
  present: boolean;
  critical: boolean;
  digitalSignature: boolean;
  nonRepudiation: boolean;
  keyEncipherment: boolean;
  dataEncipherment: boolean;
  keyAgreement: boolean;
  keyCertSign: boolean;
  cRLSign: boolean;
  malformed: boolean;
}

export interface ParsedExtendedKeyUsage {
  present: boolean;
  critical: boolean;
  oids: string[];
  malformed: boolean;
}

export interface ParsedX509Node {
  pkiCert: pkijs.Certificate;
  x509: crypto.X509Certificate;
  der: Buffer;
  fingerprint256: string;
  subject: string;
  issuer: string;
  commonName: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  isSelfIssued: boolean;
  basicConstraints: ParsedBasicConstraints;
  keyUsage: ParsedKeyUsage;
  extendedKeyUsage: ParsedExtendedKeyUsage;
  skiHex: string | null;
  akiHex: string | null;
  hasUnrecognizedCriticalExtension: boolean;
  cpf: string | null;
  sanCpf: string | null;
  cnCpf: string | null;
  icpBrasilAttrsPresent: boolean;
}

function toDerBuffer(input: unknown): Buffer {
  if (Buffer.isBuffer(input)) {
    return Buffer.from(input);
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof pkijs.Certificate) {
    return Buffer.from(input.toSchema().toBER());
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const b64 = trimmed
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  throw new Error('Formato de certificado X.509 não suportado.');
}

function parseBasicConstraintsExt(ext: pkijs.Extension | undefined): ParsedBasicConstraints {
  if (!ext) {
    return {
      present: false,
      critical: false,
      cA: false,
      pathLenConstraint: null,
      malformed: false,
    };
  }
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (!asn1.result || asn1.offset === -1 || !(asn1.result instanceof asn1js.Sequence)) {
      return {
        present: true,
        critical: Boolean(ext.critical),
        cA: false,
        pathLenConstraint: null,
        malformed: true,
      };
    }
    let cA = false;
    let pathLenConstraint: number | null = null;
    for (const item of asn1.result.valueBlock.value) {
      if (item instanceof asn1js.Boolean) {
        cA = Boolean(item.getValue());
      } else if (item instanceof asn1js.Integer) {
        const val = item.valueBlock.valueDec;
        if (item.valueBlock.isHexOnly || typeof val !== 'number' || val < 0) {
          return {
            present: true,
            critical: Boolean(ext.critical),
            cA,
            pathLenConstraint: null,
            malformed: true,
          };
        }
        pathLenConstraint = val;
      } else {
        return {
          present: true,
          critical: Boolean(ext.critical),
          cA: false,
          pathLenConstraint: null,
          malformed: true,
        };
      }
    }
    // RFC 5280 §4.2.1.9: CAs MUST include cA=TRUE when pathLenConstraint is present
    if (!cA && pathLenConstraint !== null) {
      return {
        present: true,
        critical: Boolean(ext.critical),
        cA: false,
        pathLenConstraint,
        malformed: true,
      };
    }
    return {
      present: true,
      critical: Boolean(ext.critical),
      cA,
      pathLenConstraint,
      malformed: false,
    };
  } catch {
    return {
      present: true,
      critical: Boolean(ext.critical),
      cA: false,
      pathLenConstraint: null,
      malformed: true,
    };
  }
}

function parseKeyUsageExt(ext: pkijs.Extension | undefined): ParsedKeyUsage {
  if (!ext) {
    return {
      present: false,
      critical: false,
      digitalSignature: false,
      nonRepudiation: false,
      keyEncipherment: false,
      dataEncipherment: false,
      keyAgreement: false,
      keyCertSign: false,
      cRLSign: false,
      malformed: false,
    };
  }
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (!asn1.result || asn1.offset === -1 || !(asn1.result instanceof asn1js.BitString)) {
      return {
        present: true,
        critical: Boolean(ext.critical),
        digitalSignature: false,
        nonRepudiation: false,
        keyEncipherment: false,
        dataEncipherment: false,
        keyAgreement: false,
        keyCertSign: false,
        cRLSign: false,
        malformed: true,
      };
    }
    const rawBytes = Buffer.from(asn1.result.valueBlock.valueHexView);
    const unusedBits = asn1.result.valueBlock.unusedBits || 0;
    if (rawBytes.length === 0 || unusedBits < 0 || unusedBits > 7) {
      return {
        present: true,
        critical: Boolean(ext.critical),
        digitalSignature: false,
        nonRepudiation: false,
        keyEncipherment: false,
        dataEncipherment: false,
        keyAgreement: false,
        keyCertSign: false,
        cRLSign: false,
        malformed: true,
      };
    }
    const hasBit = (bitIndex: number): boolean => {
      const byteIndex = Math.floor(bitIndex / 8);
      if (byteIndex >= rawBytes.length) return false;
      const bitInByte = 7 - (bitIndex % 8);
      if (byteIndex === rawBytes.length - 1 && bitInByte < unusedBits) {
        return false;
      }
      return (rawBytes[byteIndex] & (1 << bitInByte)) !== 0;
    };
    return {
      present: true,
      critical: Boolean(ext.critical),
      digitalSignature: hasBit(0),
      nonRepudiation: hasBit(1),
      keyEncipherment: hasBit(2),
      dataEncipherment: hasBit(3),
      keyAgreement: hasBit(4),
      keyCertSign: hasBit(5),
      cRLSign: hasBit(6),
      malformed: false,
    };
  } catch {
    return {
      present: true,
      critical: Boolean(ext.critical),
      digitalSignature: false,
      nonRepudiation: false,
      keyEncipherment: false,
      dataEncipherment: false,
      keyAgreement: false,
      keyCertSign: false,
      cRLSign: false,
      malformed: true,
    };
  }
}

function parseExtendedKeyUsageExt(ext: pkijs.Extension | undefined): ParsedExtendedKeyUsage {
  if (!ext) {
    return {
      present: false,
      critical: false,
      oids: [],
      malformed: false,
    };
  }
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (
      !asn1.result ||
      asn1.offset === -1 ||
      !(asn1.result instanceof asn1js.Sequence) ||
      asn1.result.valueBlock.value.length === 0
    ) {
      return {
        present: true,
        critical: Boolean(ext.critical),
        oids: [],
        malformed: true,
      };
    }
    const oids: string[] = [];
    for (const item of asn1.result.valueBlock.value) {
      if (!(item instanceof asn1js.ObjectIdentifier)) {
        return {
          present: true,
          critical: Boolean(ext.critical),
          oids: [],
          malformed: true,
        };
      }
      oids.push(item.valueBlock.toString());
    }
    return {
      present: true,
      critical: Boolean(ext.critical),
      oids,
      malformed: false,
    };
  } catch {
    return {
      present: true,
      critical: Boolean(ext.critical),
      oids: [],
      malformed: true,
    };
  }
}

function parseSkiExt(ext: pkijs.Extension | undefined): string | null {
  if (!ext) return null;
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (asn1.result instanceof asn1js.OctetString) {
      return Buffer.from(asn1.result.valueBlock.valueHexView).toString('hex');
    }
  } catch {
    // Ignore malformed optional SKI
  }
  return null;
}

function parseAkiExt(ext: pkijs.Extension | undefined): string | null {
  if (!ext) return null;
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (asn1.result instanceof asn1js.Sequence) {
      for (const item of asn1.result.valueBlock.value) {
        if (item.idBlock.tagClass === 3 && item.idBlock.tagNumber === 0) {
          const hexView = (item.valueBlock as { valueHexView?: Uint8Array }).valueHexView;
          if (hexView) {
            return Buffer.from(hexView).toString('hex');
          }
        }
      }
    }
  } catch {
    // Ignore malformed optional AKI
  }
  return null;
}

function extractBytesFromAsn1Node(node: unknown): Buffer | null {
  if (!node || typeof node !== 'object') return null;
  const vb = (node as {
    valueBlock?: {
      valueHexView?: Uint8Array;
      valueHex?: ArrayBuffer;
      value?: unknown[];
    };
  }).valueBlock;
  if (!vb) return null;
  if (vb.valueHexView && vb.valueHexView.byteLength > 0) {
    return Buffer.from(vb.valueHexView);
  }
  if (vb.valueHex && vb.valueHex.byteLength > 0) {
    return Buffer.from(vb.valueHex);
  }
  if (Array.isArray(vb.value)) {
    for (const child of vb.value) {
      const found = extractBytesFromAsn1Node(child);
      if (found && found.length > 0) return found;
    }
  }
  return null;
}

function extractSanIcpBrasilCpf(pkiCert: pkijs.Certificate): {
  sanCpf: string | null;
  icpBrasilAttrsPresent: boolean;
} {
  let sanCpf: string | null = null;
  let icpBrasilAttrsPresent = false;
  if (!pkiCert.extensions) {
    return { sanCpf, icpBrasilAttrsPresent };
  }
  const sanExt = pkiCert.extensions.find((e) => e.extnID === OID_SUBJECT_ALT_NAME);
  if (!sanExt) {
    return { sanCpf, icpBrasilAttrsPresent };
  }
  try {
    const view = sanExt.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer,
    );
    if (asn1.result instanceof asn1js.Sequence) {
      for (const gnNode of asn1.result.valueBlock.value) {
        if (gnNode.idBlock.tagClass === 3 && gnNode.idBlock.tagNumber === 0) {
          const children = (gnNode.valueBlock as { value?: unknown[] }).value;
          if (Array.isArray(children) && children[0] instanceof asn1js.ObjectIdentifier) {
            const typeOid = children[0].valueBlock.toString();
            if (typeOid.startsWith('2.16.76.1.3.')) {
              icpBrasilAttrsPresent = true;
            }
            if (typeOid === OID_ICP_BRASIL_PF_DATA && children[1]) {
              const rawBuf = extractBytesFromAsn1Node(children[1]);
              if (rawBuf && rawBuf.length >= 19) {
                const str = rawBuf.toString('latin1');
                const candidate = str.slice(8, 19);
                if (/^\d{11}$/.test(candidate)) {
                  sanCpf = candidate;
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Fallback
  }
  return { sanCpf, icpBrasilAttrsPresent };
}

export function parseX509Node(input: unknown): ParsedX509Node {
  const der = toDerBuffer(input);
  const pkiCert = parse(der);
  const x509 = new crypto.X509Certificate(der);

  const cnMatch = x509.subject.match(/CN=([^,\n/]+)/i);
  const cn = cnMatch ? cnMatch[1].trim() : commonName(pkiCert);

  let cnCpf: string | null = null;
  const cnCpfMatch = cn.match(/(?:[:\s-]|^)(\d{11})(?:[:\s-]|$)/);
  if (cnCpfMatch) {
    cnCpf = cnCpfMatch[1];
  } else {
    const colonMatch = x509.subject.match(/:(\d{11})/);
    if (colonMatch) {
      cnCpf = colonMatch[1];
    }
  }

  const { sanCpf, icpBrasilAttrsPresent } = extractSanIcpBrasilCpf(pkiCert);
  const cpf = extractCpfFromCertificate(x509, der);

  const extensions = pkiCert.extensions || [];
  const bcExt = extensions.find((e) => e.extnID === OID_BASIC_CONSTRAINTS);
  const kuExt = extensions.find((e) => e.extnID === OID_KEY_USAGE);
  const ekuExt = extensions.find((e) => e.extnID === OID_EXTENDED_KEY_USAGE);
  const skiExt = extensions.find((e) => e.extnID === OID_SUBJECT_KEY_IDENTIFIER);
  const akiExt = extensions.find((e) => e.extnID === OID_AUTHORITY_KEY_IDENTIFIER);

  const hasUnrecognizedCriticalExtension = extensions.some(
    (e) => Boolean(e.critical) && !RECOGNIZED_CRITICAL_EXTENSION_OIDS.has(e.extnID),
  );

  const isSelfIssued =
    pkiCert.subject.isEqual(pkiCert.issuer) || x509.subject === x509.issuer;

  return {
    pkiCert,
    x509,
    der,
    fingerprint256: x509.fingerprint256,
    subject: x509.subject,
    issuer: x509.issuer,
    commonName: cn,
    serialNumber: x509.serialNumber,
    validFrom: new Date(x509.validFrom),
    validTo: new Date(x509.validTo),
    isSelfIssued,
    basicConstraints: parseBasicConstraintsExt(bcExt),
    keyUsage: parseKeyUsageExt(kuExt),
    extendedKeyUsage: parseExtendedKeyUsageExt(ekuExt),
    skiHex: parseSkiExt(skiExt),
    akiHex: parseAkiExt(akiExt),
    hasUnrecognizedCriticalExtension,
    cpf,
    sanCpf,
    cnCpf,
    icpBrasilAttrsPresent: icpBrasilAttrsPresent || Boolean(cpf),
  };
}

function verifyCertificateSignature(
  child: ParsedX509Node,
  issuer: ParsedX509Node,
): boolean {
  try {
    return child.x509.verify(issuer.x509.publicKey);
  } catch {
    return false;
  }
}

export interface ResolvedCmsSignerCertificate {
  found: boolean;
  certificate?: pkijs.Certificate;
  der?: Buffer;
  cmsCertificates: pkijs.Certificate[];
  error?: string;
}

/**
 * Requirement 1: Identifies the exact X.509 certificate in `signedData.certificates`
 * associated with the verified `SignerInfo.sid` (IssuerAndSerialNumber or SubjectKeyIdentifier),
 * rejecting missing or ambiguous (colliding) certificates.
 */
export async function resolveCmsSignerCertificate(
  signedData: pkijs.SignedData,
  signerInfo: pkijs.SignerInfo,
): Promise<ResolvedCmsSignerCertificate> {
  const cmsCertificates: pkijs.Certificate[] = [];
  if (Array.isArray(signedData.certificates)) {
    for (const c of signedData.certificates) {
      if (c instanceof pkijs.Certificate) {
        cmsCertificates.push(c);
      }
    }
  }

  if (cmsCertificates.length === 0) {
    return {
      found: false,
      cmsCertificates: [],
      error: 'A estrutura CMS SignedData não contém certificados X.509 embutidos.',
    };
  }

  const matchedBySid: Array<{ cert: pkijs.Certificate; der: Buffer }> = [];
  const sid = signerInfo.sid;

  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    for (const cert of cmsCertificates) {
      if (
        cert.issuer.isEqual(sid.issuer) &&
        cert.serialNumber.isEqual(sid.serialNumber)
      ) {
        const der = Buffer.from(cert.toSchema().toBER());
        if (!matchedBySid.some((m) => m.der.equals(der))) {
          matchedBySid.push({ cert, der });
        }
      }
    }
  } else if (sid && typeof sid === 'object') {
    const sidObj = sid as {
      idBlock?: { isConstructed?: boolean };
      valueBlock?: {
        valueHexView?: Uint8Array;
        valueHex?: ArrayBuffer;
        value?: Array<{ valueBlock?: { valueHexView?: Uint8Array; valueHex?: ArrayBuffer } }>;
      };
    };
    const rawKeyId = sidObj.idBlock?.isConstructed
      ? sidObj.valueBlock?.value?.[0]?.valueBlock?.valueHexView ||
        (sidObj.valueBlock?.value?.[0]?.valueBlock?.valueHex
          ? new Uint8Array(sidObj.valueBlock.value[0].valueBlock.valueHex)
          : undefined)
      : sidObj.valueBlock?.valueHexView ||
        (sidObj.valueBlock?.valueHex
          ? new Uint8Array(sidObj.valueBlock.valueHex)
          : undefined);

    if (rawKeyId) {
      const targetKeyIdHex = Buffer.from(rawKeyId).toString('hex');
      for (const cert of cmsCertificates) {
        const der = Buffer.from(cert.toSchema().toBER());
        const skiExt = cert.extensions?.find(
          (e) => e.extnID === OID_SUBJECT_KEY_IDENTIFIER,
        );
        const skiHex = parseSkiExt(skiExt);
        let matchesKeyId = skiHex === targetKeyIdHex;
        if (!matchesKeyId) {
          const spkiKeyHex = crypto
            .createHash('sha1')
            .update(
              Buffer.from(
                cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
              ),
            )
            .digest('hex');
          matchesKeyId = spkiKeyHex === targetKeyIdHex;
        }
        if (matchesKeyId && !matchedBySid.some((m) => m.der.equals(der))) {
          matchedBySid.push({ cert, der });
        }
      }
    }
  }

  if (matchedBySid.length === 0) {
    return {
      found: false,
      cmsCertificates,
      error:
        'Nenhum certificado contido no CMS corresponde ao identificador (SignerIdentifier / sid) do SignerInfo.',
    };
  }

  if (matchedBySid.length > 1) {
    return {
      found: false,
      cmsCertificates,
      error:
        'Ambiguidade no CMS: múltiplos certificados distintos colidem no mesmo SignerIdentifier (sid) do SignerInfo.',
    };
  }

  return {
    found: true,
    certificate: matchedBySid[0].cert,
    der: matchedBySid[0].der,
    cmsCertificates,
  };
}

export interface EvaluateX509ChainParams {
  signerCert: unknown;
  cmsCertificates?: unknown[];
  intermediateCerts?: unknown[];
  intermediatePems?: string[];
  trustedCerts?: unknown[];
  trustedRootPems?: string[];
  allowCustomTrustAnchors?: boolean;
  purpose?: 'DOCUMENT_SIGNING' | 'TIMESTAMP_AUTHORITY';
}

export interface X509ChainEvaluationResult {
  signerIdentity: PadesSignerIdentityResult;
  chainValidation: PadesChainValidationResult;
  rootTrust: PadesRootTrustResult;
  chainNodes: ParsedX509Node[];
  subIndication?: string;
}

const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

/**
 * Evaluates the signer certificate identity, X.509 extension constraints,
 * full certification path, and root trust anchor policy (Lote 6F.2A / 6F.2B).
 *
 * Does NOT evaluate temporal validity against current wall clock as historical invalidity,
 * and does NOT query external CRL/OCSP endpoints.
 */
export async function evaluateX509ChainAndTrust(
  params: EvaluateX509ChainParams,
): Promise<X509ChainEvaluationResult> {
  const purpose = params.purpose ?? 'DOCUMENT_SIGNING';
  const signerNode = parseX509Node(params.signerCert);

  const cpfMatchesCommonName =
    signerNode.sanCpf && signerNode.cnCpf
      ? signerNode.sanCpf === signerNode.cnCpf
      : true;

  const isEndEntityCa = signerNode.basicConstraints.cA === true;

  let signerKeyUsageValid = true;
  let signerConstraintError: string | undefined;
  let signerSubIndication: string | undefined;

  if (
    signerNode.basicConstraints.malformed ||
    signerNode.keyUsage.malformed ||
    signerNode.extendedKeyUsage.malformed ||
    signerNode.hasUnrecognizedCriticalExtension
  ) {
    signerKeyUsageValid = false;
    signerConstraintError =
      'Certificado possui extensão X.509 crítica desconhecida ou malformada.';
    signerSubIndication =
      purpose === 'TIMESTAMP_AUTHORITY'
        ? 'TSA_CERT_INCOMPATIBLE'
        : 'SIGNER_CONSTRAINTS_FAILURE';
  } else if (purpose === 'DOCUMENT_SIGNING' && !cpfMatchesCommonName) {
    signerConstraintError =
      'CPF na extensão ICP-Brasil (2.16.76.1.3.1) diverge do CPF declarado no Common Name (CN) do certificado.';
    signerSubIndication = 'SIGNER_IDENTITY_MISMATCH';
  } else if (isEndEntityCa) {
    signerKeyUsageValid = false;
    signerConstraintError =
      purpose === 'TIMESTAMP_AUTHORITY'
        ? 'Certificado da TSA possui BasicConstraints cA=true (Autoridade Certificadora não pode atuar diretamente como TSA).'
        : 'Certificado do signatário é uma Autoridade Certificadora (BasicConstraints cA=true) e não pode assinar documentos finais.';
    signerSubIndication =
      purpose === 'TIMESTAMP_AUTHORITY'
        ? 'TSA_CERT_INCOMPATIBLE'
        : 'SIGNER_IS_CA_CERTIFICATE';
  } else if (signerNode.keyUsage.present) {
    const hasSigningBit =
      signerNode.keyUsage.digitalSignature || signerNode.keyUsage.nonRepudiation;
    if (!hasSigningBit || signerNode.keyUsage.keyCertSign) {
      signerKeyUsageValid = false;
      signerConstraintError =
        purpose === 'TIMESTAMP_AUTHORITY'
          ? 'Certificado da TSA possui KeyUsage incompatível com assinatura de carimbo de tempo.'
          : 'Certificado do signatário possui KeyUsage incompatível com assinatura digital de documentos.';
      signerSubIndication =
        purpose === 'TIMESTAMP_AUTHORITY'
          ? 'TSA_CERT_INCOMPATIBLE'
          : 'SIGNER_KEY_USAGE_INCOMPATIBLE';
    }
  } else if (purpose === 'TIMESTAMP_AUTHORITY' || !signerNode.isSelfIssued) {
    signerKeyUsageValid = false;
    signerConstraintError =
      purpose === 'TIMESTAMP_AUTHORITY'
        ? 'Certificado da TSA não possui extensão obrigatória KeyUsage.'
        : 'Certificado do signatário emitido por AC não possui extensão obrigatória KeyUsage para assinatura digital.';
    signerSubIndication =
      purpose === 'TIMESTAMP_AUTHORITY'
        ? 'TSA_CERT_INCOMPATIBLE'
        : 'SIGNER_KEY_USAGE_MISSING';
  }

  if (signerKeyUsageValid && !signerConstraintError) {
    if (purpose === 'TIMESTAMP_AUTHORITY') {
      // RFC 3161 §2.3: TSA certificate MUST have ExtendedKeyUsage marked critical=true with ONLY id-kp-timeStamping (1.3.6.1.5.5.7.3.8)
      const hasValidTsaEku =
        signerNode.extendedKeyUsage.present &&
        signerNode.extendedKeyUsage.critical === true &&
        signerNode.extendedKeyUsage.oids.length === 1 &&
        signerNode.extendedKeyUsage.oids[0] === OID_KP_TIME_STAMPING;
      if (!hasValidTsaEku) {
        signerKeyUsageValid = false;
        signerConstraintError =
          'Certificado da TSA não possui ExtendedKeyUsage crítico (critical = true) e exclusivo id-kp-timeStamping (1.3.6.1.5.5.7.3.8) exigido pela RFC 3161 §2.3.';
        signerSubIndication = 'TSA_EKU_INVALID';
      }
    } else if (signerNode.extendedKeyUsage.present) {
      const hasCompatibleEku = signerNode.extendedKeyUsage.oids.some((oid) =>
        ALLOWED_DOCUMENT_SIGNING_EKU_OIDS.has(oid),
      );
      if (!hasCompatibleEku) {
        signerKeyUsageValid = false;
        signerConstraintError = `Certificado do signatário possui ExtendedKeyUsage restrito a finalidades incompatíveis com assinatura de documentos (${signerNode.extendedKeyUsage.oids.join(', ')}).`;
        signerSubIndication = 'SIGNER_EXTENDED_KEY_USAGE_INCOMPATIBLE';
      }
    }
  }

  const signerIdentity: PadesSignerIdentityResult = {
    extracted: true,
    commonName: signerNode.commonName,
    cpf: signerNode.cpf,
    cpfMatchesCommonName,
    subject: signerNode.subject,
    issuer: signerNode.issuer,
    serialNumber: signerNode.serialNumber,
    fingerprint256: signerNode.fingerprint256,
    validFrom: signerNode.validFrom,
    validTo: signerNode.validTo,
    isCa: isEndEntityCa,
    keyUsageValid: signerKeyUsageValid,
    icpBrasilAttrsPresent: signerNode.icpBrasilAttrsPresent,
    error: signerConstraintError,
  };

  // Requirement 7: Custom trust anchors cannot be accepted in production without explicit trust policy
  const customRootInputs: unknown[] = [
    ...(params.trustedCerts || []),
    ...(params.trustedRootPems || []),
  ];
  const hasCustomTrustAnchors = customRootInputs.length > 0;

  if (
    hasCustomTrustAnchors &&
    process.env.NODE_ENV === 'production' &&
    params.allowCustomTrustAnchors !== true
  ) {
    const prodMsg =
      'Raiz de confiança personalizada não é aceita em produção sem política explícita de confiança (allowCustomTrustAnchors: true).';
    return {
      signerIdentity,
      chainValidation: {
        status: 'INVALID',
        valid: false,
        isSelfSigned: signerNode.isSelfIssued,
        chainLength: 1,
        chainSubjects: [signerNode.subject],
        error: prodMsg,
      },
      rootTrust: {
        trusted: false,
        rootSubject: null,
        rootFingerprint256: null,
        error: prodMsg,
      },
      chainNodes: [signerNode],
      subIndication: 'CUSTOM_TRUST_ANCHOR_FORBIDDEN_IN_PRODUCTION',
    };
  }

  // If signer certificate itself violates end-entity constraints, fail immediately as INVALID
  if (signerConstraintError || !signerKeyUsageValid || !cpfMatchesCommonName) {
    return {
      signerIdentity,
      chainValidation: {
        status: 'INVALID',
        valid: false,
        isSelfSigned: signerNode.isSelfIssued,
        chainLength: 1,
        chainSubjects: [signerNode.subject],
        error: signerConstraintError,
      },
      rootTrust: {
        trusted: false,
        rootSubject: null,
        rootFingerprint256: null,
        error: signerConstraintError,
      },
      chainNodes: [signerNode],
      subIndication: signerSubIndication || 'SIGNER_CONSTRAINTS_FAILURE',
    };
  }

  // Self-signed end-entity certificate handling
  if (signerNode.isSelfIssued) {
    if (!verifyCertificateSignature(signerNode, signerNode)) {
      const msg =
        'Assinatura criptográfica do próprio certificado autoassinado é inválida (falsificada ou corrompida).';
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: true,
          chainLength: 1,
          chainSubjects: [signerNode.subject],
          error: msg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: msg,
        },
        chainNodes: [signerNode],
        subIndication: 'CERT_SIGNATURE_INVALID',
      };
    }

    const selfSignedMsg =
      'Certificado do signatário é autoassinado e não possui cadeia até uma Autoridade Certificadora Raiz confiável.';
    return {
      signerIdentity,
      chainValidation: {
        status: 'SELF_SIGNED',
        valid: false,
        isSelfSigned: true,
        chainLength: 1,
        chainSubjects: [signerNode.subject],
        error: selfSignedMsg,
      },
      rootTrust: {
        trusted: false,
        rootSubject: null,
        rootFingerprint256: null,
        error: selfSignedMsg,
      },
      chainNodes: [signerNode],
      subIndication: 'NO_CERTIFICATE_CHAIN_FOUND_SELF_SIGNED',
    };
  }

  // Build Trust Anchor set (Requirement 6: CMS certificates are NEVER added to trustAnchors)
  const defaultBundle = bundle();
  const trustAnchorNodes: ParsedX509Node[] = hasCustomTrustAnchors
    ? customRootInputs.map((r) => parseX509Node(r))
    : defaultBundle.roots.map((r) => parseX509Node(r));

  const trustAnchorByFingerprint = new Map<string, ParsedX509Node>();
  for (const rootNode of trustAnchorNodes) {
    trustAnchorByFingerprint.set(rootNode.fingerprint256, rootNode);
  }

  // Build untrusted candidate pool for chain discovery:
  // CMS certificates + injected intermediates + default ICP-Brasil intermediates + configured trust anchors
  const rawCandidateInputs: unknown[] = [
    ...(params.cmsCertificates || []),
    ...(params.intermediateCerts || []),
    ...(params.intermediatePems || []),
    ...defaultBundle.intermediates,
    ...trustAnchorNodes.map((n) => n.pkiCert),
  ];

  const candidatePool: ParsedX509Node[] = [];
  const seenCandidateFingerprints = new Set<string>([signerNode.fingerprint256]);
  for (const item of rawCandidateInputs) {
    try {
      const node = parseX509Node(item);
      if (!seenCandidateFingerprints.has(node.fingerprint256)) {
        seenCandidateFingerprints.add(node.fingerprint256);
        candidatePool.push(node);
      }
    } catch {
      // Skip unparseable auxiliary candidate
    }
  }

  // Walk the chain from signerNode up to a Root CA
  const chain: ParsedX509Node[] = [signerNode];
  const visitedFingerprints = new Set<string>([signerNode.fingerprint256]);

  while (chain.length <= MAX_CHAIN_LENGTH) {
    const current = chain[chain.length - 1];

    // Find all candidate issuers whose Subject DN equals current.issuer
    const subjectMatchedCandidates = candidatePool.filter(
      (cand) =>
        !visitedFingerprints.has(cand.fingerprint256) &&
        (cand.pkiCert.subject.isEqual(current.pkiCert.issuer) ||
          cand.subject === current.issuer),
    );

    if (subjectMatchedCandidates.length === 0) {
      const incompleteMsg = `Cadeia de certificados incompleta: emissor "${current.issuer}" não encontrado para "${current.commonName}".`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INCOMPLETE_CHAIN',
          valid: false,
          isSelfSigned: false,
          chainLength: chain.length,
          chainSubjects: chain.map((c) => c.subject),
          error: incompleteMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: incompleteMsg,
        },
        chainNodes: chain,
        subIndication: 'INCOMPLETE_CERTIFICATE_CHAIN',
      };
    }

    // If current has AuthorityKeyIdentifier, prefer candidates with matching SubjectKeyIdentifier
    const akiFilteredCandidates = current.akiHex
      ? subjectMatchedCandidates.filter(
          (cand) => !cand.skiHex || cand.skiHex === current.akiHex,
        )
      : subjectMatchedCandidates;

    if (akiFilteredCandidates.length === 0) {
      const akiMsg = `AuthorityKeyIdentifier de "${current.commonName}" não corresponde ao SubjectKeyIdentifier do emissor "${current.issuer}".`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: chain.length,
          chainSubjects: chain.map((c) => c.subject),
          error: akiMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: akiMsg,
        },
        chainNodes: chain,
        subIndication: 'AKI_SKI_MISMATCH',
      };
    }

    // Verify cryptographic signature of `current` using candidate's public key
    const cryptographicallyValidIssuers = akiFilteredCandidates.filter((cand) =>
      verifyCertificateSignature(current, cand),
    );

    if (cryptographicallyValidIssuers.length === 0) {
      const sigMsg = `Assinatura criptográfica do certificado "${current.commonName}" inválida perante o emissor "${current.issuer}".`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: chain.length,
          chainSubjects: chain.map((c) => c.subject),
          error: sigMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: sigMsg,
        },
        chainNodes: chain,
        subIndication: 'CERT_SIGNATURE_INVALID',
      };
    }

    // Prefer a candidate that is in trustAnchorByFingerprint if multiple exist
    const issuerNode =
      cryptographicallyValidIssuers.find((c) =>
        trustAnchorByFingerprint.has(c.fingerprint256),
      ) || cryptographicallyValidIssuers[0];

    const nextChain = [...chain, issuerNode];
    const nextChainSubjects = nextChain.map((c) => c.subject);

    // Validate issuer's X.509 extension integrity
    if (
      issuerNode.basicConstraints.malformed ||
      issuerNode.keyUsage.malformed ||
      issuerNode.extendedKeyUsage.malformed ||
      issuerNode.hasUnrecognizedCriticalExtension
    ) {
      const extMsg = `Certificado emissor "${issuerNode.commonName}" possui extensão X.509 crítica desconhecida ou malformada.`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: nextChainSubjects.length,
          chainSubjects: nextChainSubjects,
          error: extMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: extMsg,
        },
        chainNodes: nextChain,
        subIndication: 'CA_EXTENSION_MALFORMED',
      };
    }

    // Validate BasicConstraints: issuer MUST have BasicConstraints with cA=true
    if (!issuerNode.basicConstraints.present || !issuerNode.basicConstraints.cA) {
      const caMsg = `Certificado emissor "${issuerNode.commonName}" não possui permissão de Autoridade Certificadora (BasicConstraints cA=false ou ausente).`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: nextChainSubjects.length,
          chainSubjects: nextChainSubjects,
          error: caMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: caMsg,
        },
        chainNodes: nextChain,
        subIndication: 'ISSUER_NOT_CA',
      };
    }

    // Validate KeyUsage: issuer CA MUST have KeyUsage with keyCertSign (bit 5)
    if (!issuerNode.keyUsage.present || !issuerNode.keyUsage.keyCertSign) {
      const kuMsg = `Certificado emissor "${issuerNode.commonName}" não possui permissão KeyUsage keyCertSign para assinar certificados.`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: nextChainSubjects.length,
          chainSubjects: nextChainSubjects,
          error: kuMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: kuMsg,
        },
        chainNodes: nextChain,
        subIndication: 'CA_KEY_USAGE_INCOMPATIBLE',
      };
    }

    // Validate RFC 5280 §4.2.1.9 pathLenConstraint:
    // Number of non-self-issued intermediate CA certificates between `issuerNode` and `signerNode` (chain[0])
    const subordinateNonSelfIssuedIntermediates = chain
      .slice(1)
      .filter((c) => !c.isSelfIssued).length;

    if (
      issuerNode.basicConstraints.pathLenConstraint !== null &&
      subordinateNonSelfIssuedIntermediates >
        issuerNode.basicConstraints.pathLenConstraint
    ) {
      const pathLenMsg = `Violação de pathLenConstraint no emissor "${issuerNode.commonName}": máximo permitido=${issuerNode.basicConstraints.pathLenConstraint}, intermediárias subordinadas=${subordinateNonSelfIssuedIntermediates}.`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'INVALID',
          valid: false,
          isSelfSigned: false,
          chainLength: nextChainSubjects.length,
          chainSubjects: nextChainSubjects,
          error: pathLenMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: null,
          rootFingerprint256: null,
          error: pathLenMsg,
        },
        chainNodes: nextChain,
        subIndication: 'PATH_LEN_CONSTRAINT_VIOLATION',
      };
    }

    chain.push(issuerNode);
    visitedFingerprints.add(issuerNode.fingerprint256);

    const matchedTrustAnchor = trustAnchorByFingerprint.get(
      issuerNode.fingerprint256,
    );
    const isExactTrustAnchor =
      matchedTrustAnchor !== undefined &&
      matchedTrustAnchor.der.equals(issuerNode.der);

    // If issuerNode is a configured trust anchor OR is self-issued (top of chain)
    if (isExactTrustAnchor || issuerNode.isSelfIssued) {
      if (issuerNode.isSelfIssued) {
        if (!verifyCertificateSignature(issuerNode, issuerNode)) {
          const rootSigMsg = `Assinatura criptográfica da Autoridade Certificadora Raiz "${issuerNode.commonName}" é inválida.`;
          return {
            signerIdentity,
            chainValidation: {
              status: 'INVALID',
              valid: false,
              isSelfSigned: false,
              chainLength: chain.length,
              chainSubjects: chain.map((c) => c.subject),
              error: rootSigMsg,
            },
            rootTrust: {
              trusted: false,
              rootSubject: issuerNode.subject,
              rootFingerprint256: issuerNode.fingerprint256,
              error: rootSigMsg,
            },
            chainNodes: chain,
            subIndication: 'ROOT_SIGNATURE_INVALID',
          };
        }
      }

      if (isExactTrustAnchor) {
        return {
          signerIdentity,
          chainValidation: {
            status: 'VALID',
            valid: true,
            isSelfSigned: false,
            chainLength: chain.length,
            chainSubjects: chain.map((c) => c.subject),
          },
          rootTrust: {
            trusted: true,
            rootSubject: issuerNode.subject,
            rootFingerprint256: issuerNode.fingerprint256,
          },
          chainNodes: chain,
        };
      }

      // Reached a self-issued Root CA that is NOT in the configured trust anchors
      const untrustedMsg = `A cadeia termina na raiz "${issuerNode.commonName}", que não faz parte das âncoras de confiança autorizadas.`;
      return {
        signerIdentity,
        chainValidation: {
          status: 'UNTRUSTED_ROOT',
          valid: false,
          isSelfSigned: false,
          chainLength: chain.length,
          chainSubjects: chain.map((c) => c.subject),
          error: untrustedMsg,
        },
        rootTrust: {
          trusted: false,
          rootSubject: issuerNode.subject,
          rootFingerprint256: issuerNode.fingerprint256,
          error: untrustedMsg,
        },
        chainNodes: chain,
        subIndication: 'UNTRUSTED_ROOT_CA',
      };
    }
  }

  const maxDepthMsg = `Cadeia de certificados excedeu a profundidade máxima permitida (${MAX_CHAIN_LENGTH}).`;
  return {
    signerIdentity,
    chainValidation: {
      status: 'INVALID',
      valid: false,
      isSelfSigned: false,
      chainLength: chain.length,
      chainSubjects: chain.map((c) => c.subject),
      error: maxDepthMsg,
    },
    rootTrust: {
      trusted: false,
      rootSubject: null,
      rootFingerprint256: null,
      error: maxDepthMsg,
    },
    chainNodes: chain,
    subIndication: 'CHAIN_DEPTH_LIMIT_EXCEEDED',
  };
}
