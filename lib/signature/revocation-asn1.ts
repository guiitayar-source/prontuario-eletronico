// Leitura de estruturas ASN.1 usadas na validação de revogação: número de série, identificador
// de chave da AC (AKI), pontos de distribuição de LCR, Issuing Distribution Point e extensões de
// entrada de LCR. Funções que só leem e devolvem dados; a decisão fica no revocation-validator.

import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import {
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
  OID_CERTIFICATE_ISSUER,
  OID_CRL_DISTRIBUTION_POINTS,
} from './revocation-oids.ts';
import type { CrlReasonName } from './types.ts';

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

export function toDerBufferFromRevocationInput(
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

export function normalizeSerialHex(integerNode: asn1js.Integer | undefined): string {
  if (!integerNode) return '';
  const raw = Buffer.from(integerNode.valueBlock.valueHexView);
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0x00) {
    start += 1;
  }
  return raw.subarray(start).toString('hex').toLowerCase();
}

export function serialNumbersEqual(
  a: asn1js.Integer | undefined,
  b: asn1js.Integer | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.isEqual(b)) return true;
  const hexA = normalizeSerialHex(a);
  const hexB = normalizeSerialHex(b);
  return hexA.length > 0 && hexA === hexB;
}

export function parseAkiKeyIdHex(ext: pkijs.Extension | undefined): string | null {
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

export interface ParsedIssuingDistributionPoint {
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

export function extractUrisFromGeneralNamesNode(node: unknown): string[] {
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

export function parseIssuingDistributionPointExt(
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

export function extractCertCrlDistributionPointUris(cert: pkijs.Certificate): {
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

export function parseEntryReasonAndInvalidity(
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
