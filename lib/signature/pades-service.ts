import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import {
  SUBFILTER_ETSI_CADES_DETACHED,
  findByteRange,
  removeTrailingNewLine,
} from '@signpdf/utils';
import {
  evaluateX509ChainAndTrust,
  resolveCmsSignerCertificate,
  type X509ChainEvaluationResult,
} from './icp-chain.ts';
import { validatePadesPdfStructure } from './pdf-structure-validator.ts';
import { evaluateTemporalValidityAndPoe } from './rfc3161-timestamp.ts';
import { evaluateDocumentRevocation } from './revocation-validator.ts';
import {
  assessSignature,
  persistenceStatusFor,
} from './verification-policy.ts';
import type {
  PadesChainValidationResult,
  PadesCmsIntegrityResult,
  PadesPdfIntegrityResult,
  PadesRevocationResult,
  PadesRootTrustResult,
  PadesSignerIdentityResult,
  PadesTemporalValidityResult,
  PadesVerificationOptions,
  PadesVerificationResult,
  PreparedPdf,
  VerificationGlobalStatus,
  VerificationStatus,
} from './types.ts';

// Ensure pkijs has WebCrypto engine initialized
try {
  const cryptoEngine = new pkijs.CryptoEngine({
    name: 'NodeJS',
    crypto: globalThis.crypto,
  });
  pkijs.setEngine('NodeJS', cryptoEngine);
} catch {
  // Already set
}

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
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

function normalizeOptions(
  optionsOrTrustedCerts?: pkijs.Certificate[] | PadesVerificationOptions,
): PadesVerificationOptions {
  if (!optionsOrTrustedCerts) return {};
  if (Array.isArray(optionsOrTrustedCerts)) {
    return { trustedCerts: optionsOrTrustedCerts };
  }
  return optionsOrTrustedCerts;
}

function parseAsn1Time(value: unknown): Date | undefined {
  if (value instanceof asn1js.UTCTime || value instanceof asn1js.GeneralizedTime) {
    const d = value.toDate();
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return undefined;
}

/**
 * Validates RFC 5035 `signingCertificate` / `signingCertificateV2` attribute against `signerCertDer`.
 */
function verifySigningCertificateAttr(
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
      if (!attrV2.values || attrV2.values.length === 0) {
        return {
          present: true,
          valid: false,
          error: 'Atributo signingCertificateV2 vazio.',
        };
      }
      const seq = attrV2.values[0];
      if (!(seq instanceof asn1js.Sequence) || seq.valueBlock.value.length === 0) {
        return {
          present: true,
          valid: false,
          error: 'Estrutura ASN.1 de signingCertificateV2 inválida.',
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
          error: 'Lista de ESSCertIDv2 vazia em signingCertificateV2.',
        };
      }
      const firstEssCertId = certsSeq.valueBlock.value[0];
      if (!(firstEssCertId instanceof asn1js.Sequence)) {
        return {
          present: true,
          valid: false,
          error: 'ESSCertIDv2 malformado.',
        };
      }
      const items = firstEssCertId.valueBlock.value;
      let hashAlgOid = '2.16.840.1.101.3.4.2.1'; // Default SHA-256 per RFC 5035
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
          error: 'certHash ausente em ESSCertIDv2.',
        };
      }

      const algEntry = ALLOWED_DIGEST_OIDS[hashAlgOid];
      if (!algEntry) {
        return {
          present: true,
          valid: false,
          error: `Algoritmo de hash não suportado em ESSCertIDv2 (${hashAlgOid}).`,
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
            'Hash do certificado em signingCertificateV2 diverge do certificado utilizado na verificação CMS.',
        };
      }

      return { present: true, valid: true };
    }

    if (attrV1) {
      if (!attrV1.values || attrV1.values.length === 0) {
        return {
          present: true,
          valid: false,
          error: 'Atributo signingCertificate vazio.',
        };
      }
      const seq = attrV1.values[0];
      if (!(seq instanceof asn1js.Sequence) || seq.valueBlock.value.length === 0) {
        return {
          present: true,
          valid: false,
          error: 'Estrutura ASN.1 de signingCertificate inválida.',
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
          error: 'Lista de ESSCertID vazia em signingCertificate.',
        };
      }
      const firstEssCertId = certsSeq.valueBlock.value[0];
      if (
        !(firstEssCertId instanceof asn1js.Sequence) ||
        !(firstEssCertId.valueBlock.value[0] instanceof asn1js.OctetString)
      ) {
        return {
          present: true,
          valid: false,
          error: 'ESSCertID malformado em signingCertificate.',
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
            'Hash do certificado em signingCertificate diverge do certificado do signatário.',
        };
      }
      return { present: true, valid: true };
    }
  } catch (err) {
    return {
      present: true,
      valid: false,
      error: `Erro ao validar atributo signingCertificate: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  return { present: false, valid: true };
}

export interface PreparePdfOptions {
  signerName: string;
  signerCpf?: string;
  reason?: string;
  contactInfo?: string;
  location?: string;
  doctorCrm?: string;
  sncrNumber?: string;
  verificationUrl?: string;
  signatureLength?: number;
  drawVisualBox?: boolean;
  allPages?: boolean;
  boxX?: number;
  boxY?: number;
}

export class PadesService {
  /**
   * Prepares a PDF document for PAdES digital signature:
   * 1. Loads the PDF and optionally adds a visual signature stamp (with QR Code) on all pages.
   * 2. Adds the cryptographic signature placeholder (ETSI.CAdES.detached).
   * 3. Calculates the exact ByteRange and computes the SHA-256 digest of the signed byte ranges.
   * 4. Returns the PreparedPdf structure ready for remote signing (only digest is sent to HSM).
   */
  async preparePdfForSignature(
    pdfInput: Uint8Array | Buffer,
    options: PreparePdfOptions
  ): Promise<PreparedPdf> {
    const pdfDoc = await PDFDocument.load(pdfInput);
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];
    const targetPages =
      options.allPages === false ? (lastPage ? [lastPage] : []) : pages;

    if (options.drawVisualBox !== false && targetPages.length > 0) {
      try {
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const qrUrl =
          options.verificationUrl ||
          (options.sncrNumber
            ? `https://sncr.anvisa.gov.br`
            : 'https://validar.iti.gov.br');
        let qrImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
        try {
          const qrPngBuffer = await QRCode.toBuffer(qrUrl, {
            type: 'png',
            margin: 1,
            width: 132,
            errorCorrectionLevel: 'M',
          });
          qrImage = await pdfDoc.embedPng(qrPngBuffer);
        } catch {
          qrImage = null;
        }

        const boxWidth = 320;
        const boxHeight = 65;
        const rightMargin = 51.1;
        // Posição vertical ajustada para y = 72 para ficar confortavelmente acima
        // do rodapé com o endereço da clínica (y: 40 e 28) e abaixo das caixas da via
        const boxY = options.boxY !== undefined ? options.boxY : 72;

        const dateStr = new Date().toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
        });

        const badgeTitle = options.sncrNumber
          ? `ASSINADO DIGITALMENTE • ICP-BRASIL • SNCR ${options.sncrNumber}`
          : 'ASSINADO DIGITALMENTE • ICP-BRASIL';

        for (const page of targetPages) {
          const boxX =
            options.boxX !== undefined
              ? options.boxX
              : page.getWidth() - boxWidth - rightMargin;

          // Background box
          page.drawRectangle({
            x: boxX,
            y: boxY,
            width: boxWidth,
            height: boxHeight,
            color: rgb(0.97, 0.98, 0.99),
            borderColor: rgb(0.15, 0.35, 0.65),
            borderWidth: 1,
          });

          // ICP-Brasil badge bar
          page.drawRectangle({
            x: boxX,
            y: boxY + boxHeight - 16,
            width: boxWidth,
            height: 16,
            color: rgb(0.15, 0.35, 0.65),
          });

          page.drawText(badgeTitle.slice(0, 62), {
            x: boxX + 8,
            y: boxY + boxHeight - 12,
            size: 7.5,
            font: fontBold,
            color: rgb(1, 1, 1),
          });

          // Signer info
          const signerLine = options.signerCpf
            ? `Signatário: ${options.signerName} (${options.signerCpf})`
            : `Signatário: ${options.signerName}`;
          page.drawText(signerLine.slice(0, 52), {
            x: boxX + 8,
            y: boxY + boxHeight - 28,
            size: 7.5,
            font: fontBold,
            color: rgb(0.1, 0.15, 0.2),
          });

          if (options.doctorCrm) {
            const crmClean = options.doctorCrm.trim();
            const crmLabel = crmClean.toUpperCase().startsWith('CRM')
              ? crmClean
              : `CRM ${crmClean}`;
            page.drawText(`Registro: ${crmLabel}`, {
              x: boxX + 8,
              y: boxY + boxHeight - 39,
              size: 7.5,
              font,
              color: rgb(0.25, 0.3, 0.35),
            });
          }

          page.drawText(`Data/Hora: ${dateStr} (Horário de Brasília)`, {
            x: boxX + 8,
            y: boxY + 12,
            size: 7,
            font,
            color: rgb(0.3, 0.35, 0.4),
          });

          page.drawText(
            'PAdES / SHA-256 • RDC Anvisa 1.000/2025 • validar.iti.gov.br',
            {
              x: boxX + 8,
              y: boxY + 3,
              size: 6,
              font,
              color: rgb(0.45, 0.5, 0.55),
            }
          );

          if (qrImage) {
            const qrSize = 44;
            page.drawImage(qrImage, {
              x: boxX + boxWidth - qrSize - 4,
              y: boxY + 3,
              width: qrSize,
              height: qrSize,
            });
          }
        }
      } catch (err) {
        console.warn('Erro ao desenhar carimbo visual no PDF:', err);
      }
    }

    // Add signature placeholder with ETSI.CAdES.detached
    const signatureLength = options.signatureLength || 16384;
    pdflibAddPlaceholder({
      pdfDoc,
      reason: options.reason || 'Documento assinado digitalmente ICP-Brasil',
      contactInfo: options.contactInfo || 'Sistema de Prontuário Eletrônico',
      name: options.signerName,
      location: options.location || 'Brasil',
      subFilter: SUBFILTER_ETSI_CADES_DETACHED,
      signatureLength,
    });

    const rawPdfBytes = await pdfDoc.save();
    const pdf = removeTrailingNewLine(Buffer.from(rawPdfBytes));

    const { byteRangePlaceholder, byteRangePlaceholderPosition } =
      findByteRange(pdf);
    if (!byteRangePlaceholder || byteRangePlaceholderPosition === undefined) {
      throw new Error(
        'Falha ao localizar marcador ByteRange no PDF com placeholder'
      );
    }

    const byteRangeEnd =
      byteRangePlaceholderPosition + byteRangePlaceholder.length;
    const contentsTagPos = pdf.indexOf('/Contents ', byteRangeEnd);
    if (contentsTagPos === -1) {
      throw new Error('Falha ao localizar tag /Contents no PDF');
    }

    const placeholderPos = pdf.indexOf('<', contentsTagPos);
    const placeholderEnd = pdf.indexOf('>', placeholderPos);
    const placeholderLengthWithBrackets = placeholderEnd + 1 - placeholderPos;

    const byteRange: [number, number, number, number] = [0, 0, 0, 0];
    byteRange[1] = placeholderPos;
    byteRange[2] = byteRange[1] + placeholderLengthWithBrackets;
    byteRange[3] = pdf.length - byteRange[2];

    let actualByteRange = `/ByteRange [${byteRange.join(' ')}]`;
    actualByteRange += ' '.repeat(
      byteRangePlaceholder.length - actualByteRange.length
    );

    const actualByteRangePdf = Buffer.concat([
      pdf.subarray(0, byteRangePlaceholderPosition),
      Buffer.from(actualByteRange),
      pdf.subarray(byteRangeEnd),
    ]);

    const contentToSign = Buffer.concat([
      actualByteRangePdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      actualByteRangePdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ]);

    const digestHex = crypto
      .createHash('sha256')
      .update(contentToSign)
      .digest('hex');

    return {
      pdfWithPlaceholder: rawPdfBytes,
      byteRange,
      contentToSign,
      digestHex,
      actualByteRangePdf,
    };
  }

  /**
   * Embeds the detached CMS signature received from the HSM into the prepared PDF.
   */
  embedSignature(
    preparedPdf: PreparedPdf,
    cmsSignatureBase64: string
  ): Buffer {
    const cleanB64 = cmsSignatureBase64
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, '');
    const rawCms = Buffer.from(cleanB64, 'base64');
    const { byteRange, actualByteRangePdf } = preparedPdf;

    const placeholderLengthWithBrackets = byteRange[2] - byteRange[1];
    const placeholderHexLength = placeholderLengthWithBrackets - 2;

    const signatureHex = rawCms.toString('hex');
    if (signatureHex.length > placeholderHexLength) {
      throw new Error(
        `A assinatura CMS (${signatureHex.length} hex) excede o espaço reservado (${placeholderHexLength} hex).`
      );
    }

    const paddedHex = signatureHex.padEnd(placeholderHexLength, '0');

    const signedPdf = Buffer.concat([
      actualByteRangePdf.subarray(0, byteRange[1]),
      Buffer.from(`<${paddedHex}>`),
      actualByteRangePdf.subarray(byteRange[2]),
    ]);

    return signedPdf;
  }

  /**
   * Cryptographically and structurally verifies a PAdES signed PDF:
   * - Validates the PDF object graph, ByteRange, decoded /Contents padding, and incremental revisions (ETSI EN 319 142-1).
   * - Verifies each signature's CMS SignedData structure, signedAttrs, messageDigest, signingCertificateV2, and cryptographic signature (RFC 5652).
   * - Evaluates certificate identity, chain, temporal validity, and revocation status (ETSI EN 319 102-1).
   */
  async verifyPadesSignature(
    pdfBuffer: Buffer,
    optionsOrTrustedCerts?: pkijs.Certificate[] | PadesVerificationOptions
  ): Promise<PadesVerificationResult> {
    const options = normalizeOptions(optionsOrTrustedCerts);
    const core = await this.evaluatePades(pdfBuffer, options);
    // Lote 6F.2C-R: `isValid`, `persistenceStatus` e `assessment` saem de uma única regra
    // (verification-policy.ts) para todos os caminhos de retorno.
    const assessment = assessSignature(core);
    return {
      ...core,
      persistenceStatus: persistenceStatusFor(core.status),
      isValid: options.requireFullTrust
        ? assessment.fullTrust
        : assessment.cryptographicIntegrity && !assessment.rejected,
      assessment,
    };
  }

  private async evaluatePades(
    pdfBuffer: Buffer,
    options: PadesVerificationOptions,
  ): Promise<Omit<PadesVerificationResult, 'assessment'>> {
    const policy = options.pdfRevisionPolicy ?? 'PADES_LTV_ALLOWED';
    const verificationTime = options.verificationTime ?? new Date();

    const emptyCmsIntegrity: PadesCmsIntegrityResult = {
      valid: false,
      signerInfoCount: 0,
      signatureVerified: false,
      signedAttrsPresent: false,
      contentTypeValid: false,
      digestAlgorithm: 'SHA-256',
      signatureAlgorithm: '',
      messageDigestAttrHex: '',
      calculatedDigestHex: '',
      digestMatches: false,
      signingCertificateAttrPresent: false,
      signingCertificateAttrValid: false,
      allSignaturesCmsValid: false,
    };

    const emptySignerIdentity: PadesSignerIdentityResult = {
      extracted: false,
      commonName: 'Desconhecido',
      cpf: null,
      cpfMatchesCommonName: false,
      subject: '',
      issuer: '',
      serialNumber: '',
      fingerprint256: '',
      validFrom: new Date(0),
      validTo: new Date(0),
      isCa: false,
      keyUsageValid: false,
      icpBrasilAttrsPresent: false,
    };

    const emptyChainValidation: PadesChainValidationResult = {
      status: 'INVALID',
      valid: false,
      isSelfSigned: false,
      chainLength: 0,
      chainSubjects: [],
    };

    const emptyRootTrust: PadesRootTrustResult = {
      trusted: false,
      rootSubject: null,
      rootFingerprint256: null,
    };

    const emptyTemporalValidity: PadesTemporalValidityResult = {
      status: 'OUT_OF_BOUNDS_NO_POE',
      valid: false,
      currentlyValid: false,
      hasTrustedPoe: false,
      poeSource: 'NONE',
      verificationTime,
    };

    const emptyRevocation: PadesRevocationResult = {
      status: 'INDETERMINATE',
      checked: false,
      source: 'NONE',
    };

    const buildInvalidResult = (
      error: string,
      pdfIntegrity: PadesPdfIntegrityResult,
      cmsIntegrity: PadesCmsIntegrityResult = emptyCmsIntegrity,
      subIndication = 'FORMAT_FAILURE',
    ): Omit<PadesVerificationResult, 'assessment'> => ({
      isValid: false,
      status: 'INVALID',
      subIndication,
      persistenceStatus: 'INVALID',
      cryptographicIntegrity: false,
      certificateTrust: false,
      isTrusted: false,
      signerName: 'Desconhecido',
      signerCpf: null,
      certificateSubject: '',
      certificateIssuer: '',
      certificateSerial: '',
      certificateFingerprint: '',
      validFrom: new Date(0),
      validTo: new Date(0),
      digestAlgorithm: cmsIntegrity.digestAlgorithm || 'SHA-256',
      messageDigestHex: cmsIntegrity.messageDigestAttrHex,
      calculatedDigestHex: cmsIntegrity.calculatedDigestHex,
      cmsIntegrity: { ...cmsIntegrity, error: cmsIntegrity.error ?? error },
      pdfIntegrity,
      signerIdentity: emptySignerIdentity,
      chainValidation: emptyChainValidation,
      rootTrust: emptyRootTrust,
      temporalValidity: emptyTemporalValidity,
      revocation: emptyRevocation,
      error,
    });

    try {
      // 1. Structural PDF & Revision Integrity Check
      const pdfIntegrity = await validatePadesPdfStructure(pdfBuffer, policy);
      if (!pdfIntegrity.valid) {
        return buildInvalidResult(
          pdfIntegrity.error || 'Estrutura PAdES do PDF inválida.',
          pdfIntegrity,
          emptyCmsIntegrity,
          pdfIntegrity.hasUnauthorizedPostSignatureUpdate
            ? 'HASH_FAILURE_POST_SIGNATURE_MODIFICATION'
            : 'FORMAT_FAILURE',
        );
      }

      // 2. Verify CMS SignedData for each /Type /Sig signature in the document
      const sigEntries = pdfIntegrity.signatures.filter((s) => s.type === 'Sig');
      if (sigEntries.length === 0) {
        return buildInvalidResult(
          'Nenhuma assinatura /Type /Sig encontrada no documento.',
          pdfIntegrity,
        );
      }

      let primaryCmsResult: PadesCmsIntegrityResult = emptyCmsIntegrity;
      let primaryChainEval: X509ChainEvaluationResult | null = null;
      let primaryClaimedSigningTime: Date | undefined;
      let primarySignerInfo: pkijs.SignerInfo | null = null;
      let primarySigEntry = sigEntries[sigEntries.length - 1];
      let primaryCmsCertificates: pkijs.Certificate[] = [];

      for (let i = 0; i < sigEntries.length; i += 1) {
        const sigEntry = sigEntries[i];
        const sigDer = sigEntry.cmsDerBytes!;
        const signedBytes = sigEntry.signedContentBytes!;

        const sigAsn1 = asn1js.fromBER(new Uint8Array(sigDer).buffer);

        if (!sigAsn1.result || sigAsn1.offset === -1) {
          sigEntry.valid = false;
          sigEntry.error = 'Falha ao decodificar ASN.1 da assinatura CMS.';
          return buildInvalidResult(sigEntry.error, pdfIntegrity);
        }

        let contentInfo: pkijs.ContentInfo;
        let signedData: pkijs.SignedData;
        try {
          contentInfo = new pkijs.ContentInfo({ schema: sigAsn1.result });
          if (contentInfo.contentType !== OID_SIGNED_DATA) {
            throw new Error(
              `ContentInfo.contentType inválido (${contentInfo.contentType}).`,
            );
          }
          signedData = new pkijs.SignedData({ schema: contentInfo.content });
        } catch (err) {
          const msg = `Estrutura CMS SignedData inválida: ${
            err instanceof Error ? err.message : String(err)
          }`;
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(msg, pdfIntegrity);
        }

        // Adjustment 4: Each individual CMS SignedData must have exactly 1 SignerInfo
        const signerInfoCount = signedData.signerInfos.length;
        if (signerInfoCount !== 1) {
          const msg = `CMS exige exatamente 1 SignerInfo por assinatura, mas encontrou ${signerInfoCount}.`;
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount,
              error: msg,
            },
            'FORMAT_FAILURE_MULTIPLE_SIGNER_INFOS',
          );
        }

        const signerInfo = signedData.signerInfos[0];
        const digestOid = signerInfo.digestAlgorithm?.algorithmId || '';
        const sigOid = signerInfo.signatureAlgorithm?.algorithmId || '';

        const digestAlgInfo = ALLOWED_DIGEST_OIDS[digestOid];
        if (!digestAlgInfo) {
          const msg = `Algoritmo de digest CMS não permitido ou inseguro (${digestOid || 'desconhecido'}).`;
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              digestAlgorithm: digestOid,
              error: msg,
            },
            'CRYPTO_CONSTRAINTS_FAILURE',
          );
        }

        const sigAlgName = ALLOWED_SIGNATURE_OIDS[sigOid];
        if (!sigAlgName) {
          const msg = `Algoritmo de assinatura CMS não permitido ou inseguro (${sigOid || 'desconhecido'}).`;
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              digestAlgorithm: digestAlgInfo.name,
              signatureAlgorithm: sigOid,
              error: msg,
            },
            'CRYPTO_CONSTRAINTS_FAILURE',
          );
        }

        const calculatedDigestBuffer = crypto
          .createHash(digestAlgInfo.nodeAlg)
          .update(signedBytes)
          .digest();
        const calculatedDigestHex = calculatedDigestBuffer.toString('hex');

        // Validate mandatory signedAttrs (RFC 5652 & ETSI EN 319 142-1)
        const signedAttrs = signerInfo.signedAttrs;
        if (!signedAttrs || !Array.isArray(signedAttrs.attributes) || signedAttrs.attributes.length === 0) {
          const msg = 'Assinatura CMS não contém atributos assinados obrigatórios (signedAttrs ausente).';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(msg, pdfIntegrity, {
            ...emptyCmsIntegrity,
            signerInfoCount: 1,
            digestAlgorithm: digestAlgInfo.name,
            signatureAlgorithm: sigAlgName,
            calculatedDigestHex,
            signedAttrsPresent: false,
            error: msg,
          });
        }

        // Check contentType attribute (1.2.840.113549.1.9.3) == id-data (1.2.840.113549.1.7.1)
        const contentTypeAttrs = signedAttrs.attributes.filter(
          (a) => a.type === OID_CONTENT_TYPE,
        );
        let contentTypeValid = false;
        if (
          contentTypeAttrs.length === 1 &&
          contentTypeAttrs[0].values?.length === 1 &&
          contentTypeAttrs[0].values[0] instanceof asn1js.ObjectIdentifier
        ) {
          contentTypeValid =
            contentTypeAttrs[0].values[0].valueBlock.toString() === OID_DATA;
        }
        if (!contentTypeValid) {
          const msg = 'Atributo assinado contentType ausente ou diferente de id-data (1.2.840.113549.1.7.1).';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(msg, pdfIntegrity, {
            ...emptyCmsIntegrity,
            signerInfoCount: 1,
            signedAttrsPresent: true,
            contentTypeValid: false,
            digestAlgorithm: digestAlgInfo.name,
            signatureAlgorithm: sigAlgName,
            calculatedDigestHex,
            error: msg,
          });
        }

        // Check messageDigest attribute (1.2.840.113549.1.9.4)
        const msgDigestAttrs = signedAttrs.attributes.filter(
          (a) => a.type === OID_MESSAGE_DIGEST,
        );
        let messageDigestAttrHex = '';
        let digestMatches = false;
        if (
          msgDigestAttrs.length === 1 &&
          msgDigestAttrs[0].values?.length === 1 &&
          msgDigestAttrs[0].values[0] instanceof asn1js.OctetString
        ) {
          const attrBytes = Buffer.from(
            msgDigestAttrs[0].values[0].valueBlock.valueHexView,
          );
          messageDigestAttrHex = attrBytes.toString('hex');
          if (attrBytes.length === calculatedDigestBuffer.length) {
            digestMatches = crypto.timingSafeEqual(
              attrBytes,
              calculatedDigestBuffer,
            );
          }
        }

        if (!digestMatches) {
          const msg =
            'O atributo messageDigest do CMS não corresponde ao hash calculado sobre o ByteRange do PDF.';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              signedAttrsPresent: true,
              contentTypeValid: true,
              digestAlgorithm: digestAlgInfo.name,
              signatureAlgorithm: sigAlgName,
              messageDigestAttrHex,
              calculatedDigestHex,
              digestMatches: false,
              error: msg,
            },
            'HASH_FAILURE',
          );
        }

        // Extract optional claimedSigningTime (1.2.840.113549.1.9.5) — Adjustment 2
        let claimedSigningTime: Date | undefined;
        const signingTimeAttr = signedAttrs.attributes.find(
          (a) => a.type === OID_SIGNING_TIME,
        );
        if (signingTimeAttr?.values?.length) {
          claimedSigningTime = parseAsn1Time(signingTimeAttr.values[0]);
        }

        // Requirement 1 (6F.2A): Identify the exact certificate associated with SignerInfo.sid
        const resolvedSigner = await resolveCmsSignerCertificate(
          signedData,
          signerInfo,
        );
        if (
          !resolvedSigner.found ||
          !resolvedSigner.certificate ||
          !resolvedSigner.der
        ) {
          const msg =
            resolvedSigner.error ||
            'Certificado associado ao SignerInfo não encontrado no CMS.';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              signedAttrsPresent: true,
              contentTypeValid: true,
              digestAlgorithm: digestAlgInfo.name,
              signatureAlgorithm: sigAlgName,
              messageDigestAttrHex,
              calculatedDigestHex,
              digestMatches: true,
              signatureVerified: false,
              error: msg,
            },
            'SIGNER_CERTIFICATE_NOT_FOUND',
          );
        }

        // Cryptographically verify the CMS signature using pkijs (without conflating chain validation)
        let signatureVerified = false;
        let signerCert: pkijs.Certificate | undefined;
        let verifyError = '';
        try {
          const result = await signedData.verify({
            signer: 0,
            data: new Uint8Array(signedBytes).buffer,
            checkChain: false,
            extendedMode: true,
          });
          signatureVerified = Boolean(result.signatureVerified);
          if (
            signatureVerified &&
            result.signerCertificate instanceof pkijs.Certificate
          ) {
            const verifiedDer = Buffer.from(
              result.signerCertificate.toSchema().toBER(),
            );
            if (!verifiedDer.equals(resolvedSigner.der)) {
              signatureVerified = false;
              verifyError =
                'Certificado utilizado na verificação criptográfica CMS diverge do certificado identificado por SignerInfo.sid.';
            } else {
              signerCert = resolvedSigner.certificate;
            }
          }
          if (!signatureVerified && !verifyError) {
            verifyError = result.message || 'Assinatura criptográfica CMS inválida.';
          }
        } catch (err) {
          verifyError =
            (err as { message?: string })?.message ||
            'Assinatura criptográfica CMS inválida.';
        }

        if (!signatureVerified || !signerCert) {
          const msg =
            verifyError ||
            'Certificado do signatário não identificado ou verificação criptográfica CMS falhou.';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              signedAttrsPresent: true,
              contentTypeValid: true,
              digestAlgorithm: digestAlgInfo.name,
              signatureAlgorithm: sigAlgName,
              messageDigestAttrHex,
              calculatedDigestHex,
              digestMatches: true,
              signatureVerified: false,
              error: msg,
            },
            'SIG_CRYPTO_FAILURE',
          );
        }

        // Verify signingCertificate / signingCertificateV2 against resolvedSigner.der
        const signerCertDer = resolvedSigner.der;
        const sigCertAttrCheck = verifySigningCertificateAttr(
          signedAttrs,
          signerCertDer,
        );
        if (!sigCertAttrCheck.valid) {
          const msg =
            sigCertAttrCheck.error ||
            'Atributo signingCertificate/signingCertificateV2 inválido.';
          sigEntry.valid = false;
          sigEntry.error = msg;
          return buildInvalidResult(
            msg,
            pdfIntegrity,
            {
              ...emptyCmsIntegrity,
              signerInfoCount: 1,
              signedAttrsPresent: true,
              contentTypeValid: true,
              digestAlgorithm: digestAlgInfo.name,
              signatureAlgorithm: sigAlgName,
              messageDigestAttrHex,
              calculatedDigestHex,
              digestMatches: true,
              signatureVerified: true,
              signingCertificateAttrPresent: sigCertAttrCheck.present,
              signingCertificateAttrValid: false,
              error: msg,
            },
            'SIG_CONSTRAINTS_FAILURE',
          );
        }

        const currentCmsResult: PadesCmsIntegrityResult = {
          valid: true,
          signerInfoCount: 1,
          signatureVerified: true,
          signedAttrsPresent: true,
          contentTypeValid: true,
          digestAlgorithm: digestAlgInfo.name,
          signatureAlgorithm: sigAlgName,
          messageDigestAttrHex,
          calculatedDigestHex,
          digestMatches: true,
          signingCertificateAttrPresent: sigCertAttrCheck.present,
          signingCertificateAttrValid: sigCertAttrCheck.valid,
          allSignaturesCmsValid: true,
        };

        // Evaluate X.509 certificate constraints, chain & trust anchors (Lote 6F.2A)
        const chainEval = await evaluateX509ChainAndTrust({
          signerCert,
          cmsCertificates: resolvedSigner.cmsCertificates,
          intermediateCerts: options.intermediateCerts,
          intermediatePems: options.intermediatePems,
          trustedCerts: options.trustedCerts,
          trustedRootPems: options.trustedRootPems,
          allowCustomTrustAnchors: options.allowCustomTrustAnchors,
        });

        // If an earlier signature in a multi-signature PDF has an INVALID certificate/chain, fail immediately
        if (
          i < sigEntries.length - 1 &&
          (chainEval.chainValidation.status === 'INVALID' ||
            !chainEval.signerIdentity.keyUsageValid ||
            chainEval.signerIdentity.isCa ||
            !chainEval.signerIdentity.cpfMatchesCommonName)
        ) {
          const errMsg =
            chainEval.chainValidation.error ||
            chainEval.signerIdentity.error ||
            'Cadeia de certificados inválida em assinatura anterior do documento.';
          sigEntry.valid = false;
          sigEntry.error = errMsg;
          return {
            ...buildInvalidResult(
              errMsg,
              pdfIntegrity,
              currentCmsResult,
              chainEval.subIndication || 'CERTIFICATE_CHAIN_INVALID',
            ),
            cryptographicIntegrity: true,
            signerName: chainEval.signerIdentity.commonName,
            signerCpf: chainEval.signerIdentity.cpf,
            certificateSubject: chainEval.signerIdentity.subject,
            certificateIssuer: chainEval.signerIdentity.issuer,
            certificateSerial: chainEval.signerIdentity.serialNumber,
            certificateFingerprint: chainEval.signerIdentity.fingerprint256,
            validFrom: chainEval.signerIdentity.validFrom,
            validTo: chainEval.signerIdentity.validTo,
            signerIdentity: chainEval.signerIdentity,
            chainValidation: chainEval.chainValidation,
            rootTrust: chainEval.rootTrust,
          };
        }

        primaryCmsResult = currentCmsResult;
        primaryChainEval = chainEval;
        primaryClaimedSigningTime = claimedSigningTime;
        primarySignerInfo = signerInfo;
        primarySigEntry = sigEntry;
        primaryCmsCertificates = resolvedSigner.cmsCertificates;
      }

      const { signerIdentity, chainValidation, rootTrust, chainNodes } =
        primaryChainEval!;
      const isSelfSigned = chainValidation.isSelfSigned;

      // Evaluate temporal validity, RFC 3161 timestamps, and authenticated External POE (Lote 6F.2B)
      const temporalValidity = await evaluateTemporalValidityAndPoe({
        pdfBuffer,
        primarySignerInfo: primarySignerInfo!,
        primarySignatureEntry: primarySigEntry,
        allSignatureEntries: pdfIntegrity.signatures,
        primaryCmsCertificates,
        signerChainNodes: chainNodes,
        claimedSigningTime: primaryClaimedSigningTime,
        verificationTime,
        options,
        calculatedDigestHex: primaryCmsResult.calculatedDigestHex,
      });
      const temporalStatus = temporalValidity.status;
      const temporalError = temporalValidity.error;

      const cryptographicIntegrity =
        pdfIntegrity.valid && primaryCmsResult.valid;
      const chainOrCertInvalid =
        chainValidation.status === 'INVALID' ||
        !signerIdentity.keyUsageValid ||
        signerIdentity.isCa ||
        !signerIdentity.cpfMatchesCommonName;

      // Lote 6F.2C: revocation of the signer chain (signer + intermediates; trust anchor excluded by policy).
      // Revocation evidence is ONLY evaluated over a chain proven valid up to a trusted anchor:
      // otherwise an attacker could build a fake chain plus a matching forged CRL/OCSP and
      // provoke a false INVALID. Without a trusted chain the result stays INDETERMINATE.
      const chainTrustedForRevocation =
        cryptographicIntegrity &&
        !chainOrCertInvalid &&
        chainValidation.valid &&
        rootTrust.trusted;

      const revocation: PadesRevocationResult = chainTrustedForRevocation
        ? await evaluateDocumentRevocation({
            signerChainNodes: chainNodes,
            temporalValidity,
            claimedSigningTime: primaryClaimedSigningTime,
            verificationTime,
            options,
            tsaRevocationSummaries: temporalValidity.tsaRevocationSummaries,
          })
        : {
            status: 'INDETERMINATE',
            checked: false,
            source: 'NONE',
            subIndication: 'REVOCATION_UNAVAILABLE',
            error:
              'Revogação não avaliada: a cadeia do signatário não foi validada até uma âncora confiável.',
          };

      const tsaTrustSatisfiedIfApplicable =
        temporalValidity.poeSource === 'RFC3161_SIGNATURE_TIMESTAMP' ||
        temporalValidity.poeSource === 'RFC3161_DOC_TIMESTAMP'
          ? temporalValidity.tsaTrustComplete === true
          : true;

      const certificateTrust =
        !chainOrCertInvalid &&
        chainValidation.valid &&
        rootTrust.trusted &&
        temporalValidity.valid &&
        tsaTrustSatisfiedIfApplicable &&
        (revocation.status === 'GOOD' || revocation.status === 'GOOD_AT_POE');

      let status: VerificationGlobalStatus;
      let subIndication: string | undefined;
      let errorMsg: string | undefined;

      if (!cryptographicIntegrity) {
        status = 'INVALID';
        subIndication = 'SIG_CRYPTO_FAILURE';
        errorMsg = primaryCmsResult.error || pdfIntegrity.error;
      } else if (chainOrCertInvalid) {
        status = 'INVALID';
        subIndication =
          primaryChainEval?.subIndication || 'CERTIFICATE_CHAIN_INVALID';
        errorMsg =
          chainValidation.error ||
          signerIdentity.error ||
          'Cadeia de certificados ou restrições X.509 inválidas.';
      } else if (
        temporalStatus === 'INVALID_TIMESTAMP' ||
        temporalStatus === 'NOT_YET_VALID' ||
        temporalStatus === 'CLAIMED_TIME_OUTSIDE_VALIDITY' ||
        temporalStatus === 'EXPIRED_AT_ISSUANCE'
      ) {
        status = 'INVALID';
        subIndication = temporalValidity.subIndication || temporalStatus;
        errorMsg = temporalError;
      } else if (revocation.status === 'REVOKED_BEFORE_POE') {
        // Only reached with authentic evidence over a trusted chain AND positive proof that the
        // signature was created at/after revocationDate (never inferred from revocationDate <= poeTime).
        status = 'INVALID';
        subIndication = revocation.subIndication || 'REVOKED_BEFORE_POE';
        errorMsg =
          revocation.error ||
          'Certificado do signatário estava revogado no instante comprovado da assinatura.';
      } else if (certificateTrust) {
        status = 'VALID';
      } else {
        // Requirement 8 & 9: Preserve global status INDETERMINATE while POE, TSA revocation, or signer revocation is insufficient/unavailable.
        // Point 4 (6F.2C contract): Corrupted/unusable CRL or OCSP evidence (INVALID_EVIDENCE) NEVER forces INVALID; it stays INDETERMINATE.
        status = 'INDETERMINATE';
        if (temporalValidity.subIndication) {
          subIndication = temporalValidity.subIndication;
        } else if (temporalStatus === 'OUT_OF_BOUNDS_AT_POE') {
          subIndication = 'OUT_OF_BOUNDS_AT_POE';
        } else if (temporalStatus === 'OUT_OF_BOUNDS_NO_POE') {
          subIndication = 'OUT_OF_BOUNDS_NO_POE';
        } else if (isSelfSigned || chainValidation.status === 'SELF_SIGNED') {
          subIndication = 'NO_CERTIFICATE_CHAIN_FOUND_SELF_SIGNED';
        } else if (chainValidation.status === 'INCOMPLETE_CHAIN') {
          subIndication = 'INCOMPLETE_CERTIFICATE_CHAIN';
        } else if (chainValidation.status === 'UNTRUSTED_ROOT') {
          subIndication = 'UNTRUSTED_ROOT_CA';
        } else if (revocation.status === 'INVALID_EVIDENCE') {
          subIndication = 'REVOCATION_EVIDENCE_INVALID';
        } else if (
          revocation.status !== 'GOOD' &&
          revocation.status !== 'GOOD_AT_POE'
        ) {
          subIndication =
            revocation.subIndication ||
            (revocation.status === 'REVOKED_NO_POE'
              ? 'REVOKED_NO_POE'
              : 'REVOCATION_UNAVAILABLE');
        } else if (!tsaTrustSatisfiedIfApplicable) {
          const tsaPending = temporalValidity.tsaRevocationSummaries?.find(
            (r) => r.status !== 'GOOD' && r.status !== 'GOOD_AT_POE',
          );
          subIndication =
            tsaPending?.subIndication || 'TSA_REVOCATION_UNAVAILABLE';
        } else {
          subIndication = 'REVOCATION_UNAVAILABLE';
        }
      }

      const persistenceStatus: VerificationStatus =
        status === 'VALID'
          ? 'VALID'
          : status === 'INVALID'
            ? 'INVALID'
            : 'UNVERIFIED';

      const isTrusted = status === 'VALID';
      const isValid = options.requireFullTrust
        ? status === 'VALID'
        : cryptographicIntegrity && status !== 'INVALID';

      return {
        isValid,
        status,
        subIndication,
        persistenceStatus,
        cryptographicIntegrity,
        certificateTrust,
        isTrusted,
        signerName: signerIdentity.commonName,
        signerCpf: signerIdentity.cpf,
        certificateSubject: signerIdentity.subject,
        certificateIssuer: signerIdentity.issuer,
        certificateSerial: signerIdentity.serialNumber,
        certificateFingerprint: signerIdentity.fingerprint256,
        validFrom: signerIdentity.validFrom,
        validTo: signerIdentity.validTo,
        digestAlgorithm: primaryCmsResult.digestAlgorithm,
        messageDigestHex: primaryCmsResult.messageDigestAttrHex,
        calculatedDigestHex: primaryCmsResult.calculatedDigestHex,
        signedAt: primaryClaimedSigningTime,
        claimedSigningTime: primaryClaimedSigningTime,
        poeTime: temporalValidity.hasTrustedPoe
          ? temporalValidity.poeTime
          : undefined,
        cmsIntegrity: primaryCmsResult,
        pdfIntegrity,
        signerIdentity,
        chainValidation,
        rootTrust,
        temporalValidity,
        revocation,
        error: status === 'INVALID' ? errorMsg : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return buildInvalidResult(msg, {
        valid: false,
        policy,
        byteRange: null,
        coversWholeDocument: false,
        unsignedTrailingBytes: 0,
        contentsHexValid: false,
        contentsPaddingValid: false,
        totalRevisionsCount: 0,
        preSignatureRevisionsCount: 0,
        signatureRevisionsCount: 0,
        postSignatureLtvRevisionsCount: 0,
        hasUnauthorizedPostSignatureUpdate: false,
        revisions: [],
        signatures: [],
        error: msg,
      });
    }
  }
}

export const padesService = new PadesService();
