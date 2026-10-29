import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { parseX509Node, type ParsedX509Node } from './icp-chain.ts';
import type {
  CertificateRevocationCheckSummary,
  CrlReasonName,
  PadesRevocationResult,
  PadesTemporalValidityResult,
  PadesVerificationOptions,
} from './types.ts';

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine already initialized
}

export const OID_AUTHORITY_KEY_IDENTIFIER = '2.5.29.35';
export const OID_ISSUER_ALT_NAME = '2.5.29.18';
export const OID_CRL_NUMBER = '2.5.29.20';
export const OID_CRL_REASON = '2.5.29.21';
export const OID_INVALIDITY_DATE = '2.5.29.24';
export const OID_DELTA_CRL_INDICATOR = '2.5.29.27';
export const OID_ISSUING_DISTRIBUTION_POINT = '2.5.29.28';
export const OID_CERTIFICATE_ISSUER = '2.5.29.29';
export const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';
export const OID_FRESHEST_CRL = '2.5.29.46';
export const OID_AUTHORITY_INFO_ACCESS = '1.3.6.1.5.5.7.1.1';

export const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
export const OID_PKIX_OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';
export const OID_PKIX_OCSP_NONCE = '1.3.6.1.5.5.7.48.1.2';
export const OID_PKIX_OCSP_CRL = '1.3.6.1.5.5.7.48.1.3';
export const OID_PKIX_OCSP_RESPONSE = '1.3.6.1.5.5.7.48.1.4';
export const OID_PKIX_OCSP_NOCHECK = '1.3.6.1.5.5.7.48.1.5';
export const OID_PKIX_OCSP_ARCHIVE_CUTOFF = '1.3.6.1.5.5.7.48.1.6';

const ALLOWED_SIGNATURE_OIDS: Record<
  string,
  { name: string; digestName: 'SHA-256' | 'SHA-384' | 'SHA-512' }
> = {
  '1.2.840.113549.1.1.10': { name: 'RSASSA-PSS', digestName: 'SHA-256' },
  '1.2.840.113549.1.1.11': { name: 'SHA256withRSA', digestName: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'SHA384withRSA', digestName: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'SHA512withRSA', digestName: 'SHA-512' },
  '1.2.840.10045.4.3.2': { name: 'ECDSAwithSHA256', digestName: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSAwithSHA384', digestName: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSAwithSHA512', digestName: 'SHA-512' },
};

const ALLOWED_CERTID_HASH_OIDS: Record<
  string,
  'sha1' | 'sha256' | 'sha384' | 'sha512'
> = {
  '1.3.14.3.2.26': 'sha1', // RFC 6960 mandatory-to-implement for CertID
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

const RECOGNIZED_CRL_CRITICAL_EXT_OIDS = new Set<string>([
  OID_ISSUING_DISTRIBUTION_POINT,
  OID_DELTA_CRL_INDICATOR,
]);

const RECOGNIZED_CRL_ENTRY_CRITICAL_EXT_OIDS = new Set<string>([
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_CERTIFICATE_ISSUER,
]);

const RECOGNIZED_OCSP_RESPONSE_CRITICAL_EXT_OIDS = new Set<string>([
  OID_PKIX_OCSP_NONCE,
  OID_PKIX_OCSP_CRL,
  OID_PKIX_OCSP_RESPONSE,
  OID_PKIX_OCSP_ARCHIVE_CUTOFF,
]);

const RECOGNIZED_OCSP_SINGLE_CRITICAL_EXT_OIDS = new Set<string>([
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_PKIX_OCSP_ARCHIVE_CUTOFF,
]);

export function mapCrlReasonCodeToName(code: number | undefined): CrlReasonName | undefined {
  if (code === undefined) return undefined;
  switch (code) {
    case 0:
      return 'unspecified';
    case 1:
      return 'keyCompromise';
    case 2:
      return 'cACompromise';
    case 3:
      return 'affiliationChanged';
    case 4:
      return 'superseded';
    case 5:
      return 'cessationOfOperation';
    case 6:
      return 'certificateHold';
    case 8:
      return 'removeFromCRL';
    case 9:
      return 'privilegeWithdrawn';
    case 10:
      return 'aACompromise';
    default:
      return 'unknown';
  }
}

function toDerBufferFromRevocationInput(
  input: Buffer | Uint8Array | string,
): Buffer {
  if (Buffer.isBuffer(input)) {
    return Buffer.from(input);
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const cleaned = trimmed
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '');
    if (!cleaned || !/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
      throw new Error('Codificação base64/PEM inválida para evidência de revogação.');
    }
    return Buffer.from(cleaned, 'base64');
  }
  throw new Error('Formato de evidência de revogação não suportado.');
}

function normalizeSerialHex(integerNode: asn1js.Integer | undefined): string {
  if (!integerNode) return '';
  const raw = Buffer.from(integerNode.valueBlock.valueHexView);
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0x00) {
    start += 1;
  }
  return raw.subarray(start).toString('hex').toLowerCase();
}

function serialNumbersEqual(
  a: asn1js.Integer | undefined,
  b: asn1js.Integer | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.isEqual(b)) return true;
  const hexA = normalizeSerialHex(a);
  const hexB = normalizeSerialHex(b);
  return hexA.length > 0 && hexA === hexB;
}

function parseAkiKeyIdHex(ext: pkijs.Extension | undefined): string | null {
  if (!ext) return null;
  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      ) as ArrayBuffer,
    );
    if (asn1.result instanceof asn1js.Sequence) {
      for (const item of asn1.result.valueBlock.value) {
        if (item.idBlock.tagClass === 3 && item.idBlock.tagNumber === 0) {
          const hexView = (item.valueBlock as { valueHexView?: Uint8Array })
            .valueHexView;
          if (hexView) {
            return Buffer.from(hexView).toString('hex').toLowerCase();
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface ParsedIssuingDistributionPoint {
  present: boolean;
  malformed: boolean;
  hasDistributionPointName: boolean;
  hasRelativeName: boolean;
  distributionPointUris: string[];
  onlyContainsUserCerts: boolean;
  onlyContainsCACerts: boolean;
  onlySomeReasonsPresent: boolean;
  indirectCRL: boolean;
  onlyContainsAttributeCerts: boolean;
}

function extractUrisFromGeneralNamesNode(node: unknown): string[] {
  const uris: string[] = [];
  if (!node || typeof node !== 'object') return uris;
  const idBlock = (node as { idBlock?: { tagClass?: number; tagNumber?: number } })
    .idBlock;
  const valueBlock = (
    node as {
      valueBlock?: { valueHexView?: Uint8Array; value?: unknown[] };
    }
  ).valueBlock;

  // GeneralName uniformResourceIdentifier is [6] IMPLICIT IA5String (tagClass = 3, tagNumber = 6)
  if (
    idBlock?.tagClass === 3 &&
    idBlock?.tagNumber === 6 &&
    valueBlock?.valueHexView &&
    valueBlock.valueHexView.byteLength > 0
  ) {
    uris.push(
      Buffer.from(valueBlock.valueHexView).toString('latin1').trim(),
    );
  }

  if (Array.isArray(valueBlock?.value)) {
    for (const child of valueBlock.value) {
      uris.push(...extractUrisFromGeneralNamesNode(child));
    }
  }
  return uris;
}

function parseIssuingDistributionPointExt(
  ext: pkijs.Extension | undefined,
): ParsedIssuingDistributionPoint {
  if (!ext) {
    return {
      present: false,
      malformed: false,
      hasDistributionPointName: false,
      hasRelativeName: false,
      distributionPointUris: [],
      onlyContainsUserCerts: false,
      onlyContainsCACerts: false,
      onlySomeReasonsPresent: false,
      indirectCRL: false,
      onlyContainsAttributeCerts: false,
    };
  }

  try {
    const view = ext.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      ) as ArrayBuffer,
    );
    if (
      !asn1.result ||
      asn1.offset === -1 ||
      !(asn1.result instanceof asn1js.Sequence) ||
      asn1.result.valueBlock.value.length === 0
    ) {
      return {
        present: true,
        malformed: true,
        hasDistributionPointName: false,
        hasRelativeName: false,
        distributionPointUris: [],
        onlyContainsUserCerts: false,
        onlyContainsCACerts: false,
        onlySomeReasonsPresent: false,
        indirectCRL: false,
        onlyContainsAttributeCerts: false,
      };
    }

    let hasDistributionPointName = false;
    let hasRelativeName = false;
    const distributionPointUris: string[] = [];
    let onlyContainsUserCerts = false;
    let onlyContainsCACerts = false;
    let onlySomeReasonsPresent = false;
    let indirectCRL = false;
    let onlyContainsAttributeCerts = false;

    const readContextBoolean = (item: unknown): boolean | null => {
      const vb = (
        item as {
          valueBlock?: { valueHexView?: Uint8Array; value?: unknown[] };
        }
      ).valueBlock;
      if (vb?.valueHexView && vb.valueHexView.byteLength === 1) {
        return vb.valueHexView[0] !== 0;
      }
      if (Array.isArray(vb?.value) && vb.value[0] instanceof asn1js.Boolean) {
        return Boolean(vb.value[0].getValue());
      }
      return null;
    };

    for (const item of asn1.result.valueBlock.value) {
      if (item.idBlock.tagClass !== 3) {
        return {
          present: true,
          malformed: true,
          hasDistributionPointName: false,
          hasRelativeName: false,
          distributionPointUris: [],
          onlyContainsUserCerts: false,
          onlyContainsCACerts: false,
          onlySomeReasonsPresent: false,
          indirectCRL: false,
          onlyContainsAttributeCerts: false,
        };
      }

      switch (item.idBlock.tagNumber) {
        case 0: {
          hasDistributionPointName = true;
          const children = (item.valueBlock as { value?: unknown[] }).value;
          if (Array.isArray(children) && children.length > 0) {
            const firstChild = children[0] as {
              idBlock?: { tagClass?: number; tagNumber?: number };
            };
            if (
              firstChild.idBlock?.tagClass === 3 &&
              firstChild.idBlock?.tagNumber === 1
            ) {
              hasRelativeName = true;
            }
          }
          distributionPointUris.push(...extractUrisFromGeneralNamesNode(item));
          break;
        }
        case 1: {
          const b = readContextBoolean(item);
          if (b === null) {
            return {
              present: true,
              malformed: true,
              hasDistributionPointName: false,
              hasRelativeName: false,
              distributionPointUris: [],
              onlyContainsUserCerts: false,
              onlyContainsCACerts: false,
              onlySomeReasonsPresent: false,
              indirectCRL: false,
              onlyContainsAttributeCerts: false,
            };
          }
          onlyContainsUserCerts = b;
          break;
        }
        case 2: {
          const b = readContextBoolean(item);
          if (b === null) {
            return {
              present: true,
              malformed: true,
              hasDistributionPointName: false,
              hasRelativeName: false,
              distributionPointUris: [],
              onlyContainsUserCerts: false,
              onlyContainsCACerts: false,
              onlySomeReasonsPresent: false,
              indirectCRL: false,
              onlyContainsAttributeCerts: false,
            };
          }
          onlyContainsCACerts = b;
          break;
        }
        case 3: {
          onlySomeReasonsPresent = true;
          break;
        }
        case 4: {
          const b = readContextBoolean(item);
          if (b === null) {
            return {
              present: true,
              malformed: true,
              hasDistributionPointName: false,
              hasRelativeName: false,
              distributionPointUris: [],
              onlyContainsUserCerts: false,
              onlyContainsCACerts: false,
              onlySomeReasonsPresent: false,
              indirectCRL: false,
              onlyContainsAttributeCerts: false,
            };
          }
          indirectCRL = b;
          break;
        }
        case 5: {
          const b = readContextBoolean(item);
          if (b === null) {
            return {
              present: true,
              malformed: true,
              hasDistributionPointName: false,
              hasRelativeName: false,
              distributionPointUris: [],
              onlyContainsUserCerts: false,
              onlyContainsCACerts: false,
              onlySomeReasonsPresent: false,
              indirectCRL: false,
              onlyContainsAttributeCerts: false,
            };
          }
          onlyContainsAttributeCerts = b;
          break;
        }
        default:
          return {
            present: true,
            malformed: true,
            hasDistributionPointName: false,
            hasRelativeName: false,
            distributionPointUris: [],
            onlyContainsUserCerts: false,
            onlyContainsCACerts: false,
            onlySomeReasonsPresent: false,
            indirectCRL: false,
            onlyContainsAttributeCerts: false,
          };
      }
    }

    // RFC 5280 §5.2.5: at most one of onlyContainsUserCerts, onlyContainsCACerts, onlyContainsAttributeCerts may be true
    const ScopeFlagsCount =
      (onlyContainsUserCerts ? 1 : 0) +
      (onlyContainsCACerts ? 1 : 0) +
      (onlyContainsAttributeCerts ? 1 : 0);
    if (ScopeFlagsCount > 1) {
      return {
        present: true,
        malformed: true,
        hasDistributionPointName,
        hasRelativeName,
        distributionPointUris,
        onlyContainsUserCerts,
        onlyContainsCACerts,
        onlySomeReasonsPresent,
        indirectCRL,
        onlyContainsAttributeCerts,
      };
    }

    return {
      present: true,
      malformed: false,
      hasDistributionPointName,
      hasRelativeName,
      distributionPointUris,
      onlyContainsUserCerts,
      onlyContainsCACerts,
      onlySomeReasonsPresent,
      indirectCRL,
      onlyContainsAttributeCerts,
    };
  } catch {
    return {
      present: true,
      malformed: true,
      hasDistributionPointName: false,
      hasRelativeName: false,
      distributionPointUris: [],
      onlyContainsUserCerts: false,
      onlyContainsCACerts: false,
      onlySomeReasonsPresent: false,
      indirectCRL: false,
      onlyContainsAttributeCerts: false,
    };
  }
}

function extractCertCrlDistributionPointUris(cert: pkijs.Certificate): {
  present: boolean;
  uris: string[];
  hasIndirectCrlIssuerOnly: boolean;
  hasPartialReasonsOnly: boolean;
} {
  const cdpExt = cert.extensions?.find(
    (e) => e.extnID === OID_CRL_DISTRIBUTION_POINTS,
  );
  if (!cdpExt) {
    return {
      present: false,
      uris: [],
      hasIndirectCrlIssuerOnly: false,
      hasPartialReasonsOnly: false,
    };
  }

  try {
    const view = cdpExt.extnValue.valueBlock.valueHexView;
    const asn1 = asn1js.fromBER(
      view.buffer.slice(
        view.byteOffset,
        view.byteOffset + view.byteLength,
      ) as ArrayBuffer,
    );
    if (!(asn1.result instanceof asn1js.Sequence)) {
      return {
        present: true,
        uris: [],
        hasIndirectCrlIssuerOnly: false,
        hasPartialReasonsOnly: false,
      };
    }

    const uris: string[] = [];
    let dpCount = 0;
    let indirectCount = 0;
    let reasonsCount = 0;

    for (const dpSeq of asn1.result.valueBlock.value) {
      if (!(dpSeq instanceof asn1js.Sequence)) continue;
      dpCount += 1;
      for (const field of dpSeq.valueBlock.value) {
        if (field.idBlock.tagClass === 3 && field.idBlock.tagNumber === 0) {
          uris.push(...extractUrisFromGeneralNamesNode(field));
        } else if (
          field.idBlock.tagClass === 3 &&
          field.idBlock.tagNumber === 1
        ) {
          reasonsCount += 1;
        } else if (
          field.idBlock.tagClass === 3 &&
          field.idBlock.tagNumber === 2
        ) {
          indirectCount += 1;
        }
      }
    }

    return {
      present: true,
      uris,
      hasIndirectCrlIssuerOnly: dpCount > 0 && indirectCount === dpCount,
      hasPartialReasonsOnly: dpCount > 0 && reasonsCount === dpCount,
    };
  } catch {
    return {
      present: true,
      uris: [],
      hasIndirectCrlIssuerOnly: false,
      hasPartialReasonsOnly: false,
    };
  }
}

function parseEntryReasonAndInvalidity(
  extensions: pkijs.Extension[] | undefined,
  recognizedCriticalOids: Set<string>,
): {
  reasonCode?: number;
  reasonName?: CrlReasonName;
  invalidityDate?: Date;
  hasIndirectCertIssuer: boolean;
  hasUnrecognizedCriticalExtension: boolean;
  malformed: boolean;
} {
  if (!extensions || extensions.length === 0) {
    return {
      hasIndirectCertIssuer: false,
      hasUnrecognizedCriticalExtension: false,
      malformed: false,
    };
  }

  let reasonCode: number | undefined;
  let invalidityDate: Date | undefined;
  let hasIndirectCertIssuer = false;
  let hasUnrecognizedCriticalExtension = false;

  for (const ext of extensions) {
    if (ext.critical && !recognizedCriticalOids.has(ext.extnID)) {
      hasUnrecognizedCriticalExtension = true;
    }

    if (ext.extnID === OID_CERTIFICATE_ISSUER) {
      hasIndirectCertIssuer = true;
    } else if (ext.extnID === OID_CRL_REASON) {
      try {
        const view = ext.extnValue.valueBlock.valueHexView;
        const asn1 = asn1js.fromBER(
          view.buffer.slice(
            view.byteOffset,
            view.byteOffset + view.byteLength,
          ) as ArrayBuffer,
        );
        if (!(asn1.result instanceof asn1js.Enumerated)) {
          return {
            hasIndirectCertIssuer,
            hasUnrecognizedCriticalExtension,
            malformed: true,
          };
        }
        reasonCode = asn1.result.valueBlock.valueDec;
      } catch {
        return {
          hasIndirectCertIssuer,
          hasUnrecognizedCriticalExtension,
          malformed: true,
        };
      }
    } else if (ext.extnID === OID_INVALIDITY_DATE) {
      try {
        const view = ext.extnValue.valueBlock.valueHexView;
        const asn1 = asn1js.fromBER(
          view.buffer.slice(
            view.byteOffset,
            view.byteOffset + view.byteLength,
          ) as ArrayBuffer,
        );
        if (
          asn1.result instanceof asn1js.GeneralizedTime ||
          asn1.result instanceof asn1js.UTCTime
        ) {
          const d = asn1.result.toDate();
          if (d instanceof Date && !Number.isNaN(d.getTime())) {
            invalidityDate = d;
          } else {
            return {
              hasIndirectCertIssuer,
              hasUnrecognizedCriticalExtension,
              malformed: true,
            };
          }
        } else {
          return {
            hasIndirectCertIssuer,
            hasUnrecognizedCriticalExtension,
            malformed: true,
          };
        }
      } catch {
        return {
          hasIndirectCertIssuer,
          hasUnrecognizedCriticalExtension,
          malformed: true,
        };
      }
    }
  }

  return {
    reasonCode,
    reasonName: mapCrlReasonCodeToName(reasonCode),
    invalidityDate,
    hasIndirectCertIssuer,
    hasUnrecognizedCriticalExtension,
    malformed: false,
  };
}

/**
 * Política de frescor (Lote 6F.2C-R) — ver docs/auditorias/6f2c/CORRECAO-6F2C-R.md.
 *
 * - CURRENT (sem POE confiável completa; referência = instante da verificação): a evidência de
 *   não revogação precisa estar vigente agora — `thisUpdate ≤ agora ≤ nextUpdate`
 *   (RFC 5280 §6.3.3; RFC 6960 §4.2.2.1). OCSP sem nextUpdate vale até `maxAgeWithoutNextUpdateMs`
 *   após thisUpdate. Se `maxAgeMs` for definido, limita a idade de qualquer evidência
 *   (ETSI EN 319 102-1 §5.2.5.4, "maximum accepted revocation freshness").
 * - HISTORICAL (POE confiável completa; referência = poeTime): só prova não revogação na POE a
 *   evidência emitida em/depois de `poeTime + gracePeriodMs` e antes do vencimento do certificado.
 *   Ela NÃO precisa estar vigente no instante da verificação (validação de longo prazo).
 *   Evidência emitida antes da POE nunca comprova GOOD na POE, ainda que siga vigente.
 * - COVERING_OR_LATER: uso interno (status do respondente OCSP delegado em producedAt): aceita
 *   evidência vigente em `ref` ou emitida depois dele.
 *
 * Evidência de revogação/suspensão é fato autêntico e não depende de frescor.
 */
export interface RevocationFreshnessContext {
  mode: 'CURRENT' | 'HISTORICAL' | 'COVERING_OR_LATER';
  gracePeriodMs: number;
  maxAgeMs?: number;
  maxAgeWithoutNextUpdateMs: number;
}

export const DEFAULT_OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_SECONDS = 24 * 60 * 60;

export function freshnessContextFromOptions(
  options: PadesVerificationOptions,
  mode: RevocationFreshnessContext['mode'],
): RevocationFreshnessContext {
  const f = options.revocationFreshness ?? {};
  const seconds = (v: number | undefined, fallback?: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? v * 1000
      : fallback === undefined
        ? undefined
        : fallback * 1000;
  return {
    mode,
    gracePeriodMs: seconds(f.gracePeriodSeconds, 0)!,
    maxAgeMs: seconds(f.maxAgeSeconds),
    maxAgeWithoutNextUpdateMs: seconds(
      f.maxAgeWithoutNextUpdateSeconds,
      DEFAULT_OCSP_MAX_AGE_WITHOUT_NEXT_UPDATE_SECONDS,
    )!,
  };
}

/**
 * Decide se uma evidência AUTÊNTICA de "não revogado" comprova o estado no instante de referência.
 * Retorna `null` quando comprova, ou a explicação de por que não comprova.
 */
function goodEvidenceFreshnessProblem(params: {
  thisUpdate: Date;
  nextUpdate?: Date;
  referenceTime: Date;
  verificationTime: Date;
  targetValidTo: Date;
  freshness: RevocationFreshnessContext;
}): string | null {
  const { thisUpdate, nextUpdate, referenceTime, verificationTime, freshness } =
    params;
  // A AC pode retirar da lista certificados vencidos: evidência posterior ao vencimento não prova nada.
  if (thisUpdate > params.targetValidTo)
    return `emitida (${thisUpdate.toISOString()}) depois do vencimento do certificado (${params.targetValidTo.toISOString()})`;

  const coversReference =
    thisUpdate <= referenceTime &&
    (nextUpdate
      ? referenceTime <= nextUpdate
      : referenceTime.getTime() - thisUpdate.getTime() <=
        freshness.maxAgeWithoutNextUpdateMs);

  if (freshness.mode === 'CURRENT') {
    if (!coversReference)
      return `não vigente no instante da verificação (${referenceTime.toISOString()})`;
    if (
      freshness.maxAgeMs !== undefined &&
      verificationTime.getTime() - thisUpdate.getTime() > freshness.maxAgeMs
    )
      return `mais antiga que a idade máxima aceita (${Math.round(freshness.maxAgeMs / 1000)} s)`;
    return null;
  }

  const issuedAfterReference =
    thisUpdate.getTime() >= referenceTime.getTime() + freshness.gracePeriodMs;
  if (freshness.mode === 'HISTORICAL') {
    return issuedAfterReference
      ? null
      : `emitida (${thisUpdate.toISOString()}) antes de POE + carência (${new Date(referenceTime.getTime() + freshness.gracePeriodMs).toISOString()}); não comprova a ausência de revogação na POE`;
  }
  return coversReference || thisUpdate >= referenceTime
    ? null
    : `não cobre o instante de referência (${referenceTime.toISOString()})`;
}

export interface SingleEvidenceEvaluation {
  source: 'CRL' | 'OCSP';
  matchKind:
    | 'MATCHED_VALID'
    /** Autêntica e aplicável, mas não comprova não revogação no instante de referência. */
    | 'NOT_FRESH'
    /** Resposta sem conteúdo autenticado (ex.: OCSP tryLater): não é evidência. */
    | 'UNAVAILABLE'
    | 'SCOPE_INCOMPATIBLE'
    | 'INVALID_EVIDENCE'
    | 'UNRELATED_ISSUER';
  certStatus?: 'GOOD' | 'REVOKED' | 'CERTIFICATE_HOLD' | 'UNKNOWN' | 'TRY_LATER';
  thisUpdate?: Date;
  nextUpdate?: Date;
  producedAt?: Date;
  revokedAt?: Date;
  invalidityDate?: Date;
  reasonCode?: number;
  reasonName?: CrlReasonName;
  subIndication?: string;
  error?: string;
}

/**
 * Validates a single CRL (RFC 5280) against a target certificate (`targetNode`) and its verified
 * issuer CA (`issuerNode`) at `referenceTime` / `verificationTime`.
 */
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

  const asn1 = asn1js.fromBER(
    der.buffer.slice(
      der.byteOffset,
      der.byteOffset + der.byteLength,
    ) as ArrayBuffer,
  );
  if (!asn1.result || asn1.offset === -1 || asn1.offset !== der.length) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: 'Falha ao decodificar estrutura ASN.1 DER da CRL X.509.',
    };
  }

  let crl: pkijs.CertificateRevocationList;
  try {
    crl = new pkijs.CertificateRevocationList({ schema: asn1.result });
  } catch (err) {
    return {
      source: 'CRL',
      matchKind: 'INVALID_EVIDENCE',
      subIndication: 'REVOCATION_EVIDENCE_INVALID',
      error: `Estrutura CertificateList X.509 inválida: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

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

/**
 * Instante efetivo de revogação: o menor entre revocationDate e invalidityDate
 * (RFC 5280 §5.3.2), qualquer que seja o motivo.
 */
export function effectiveRevocationTime(
  revokedAt: Date,
  invalidityDate?: Date,
): Date {
  return invalidityDate && invalidityDate < revokedAt
    ? invalidityDate
    : revokedAt;
}

/**
 * Motivos em que o comprometimento pode anteceder a data administrativa de revogação:
 * keyCompromise (1), cACompromise (2), aACompromise (10) e códigos não reconhecidos (7, > 10).
 */
export function requiresConservativeRevocationTime(
  reasonCode: number | undefined,
): boolean {
  if (reasonCode === undefined) return false;
  return (
    reasonCode === 1 ||
    reasonCode === 2 ||
    reasonCode === 10 ||
    mapCrlReasonCodeToName(reasonCode) === 'unknown'
  );
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
