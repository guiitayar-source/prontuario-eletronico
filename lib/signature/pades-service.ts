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
  extractSignature,
} from '@signpdf/utils';
import { parseX509Certificate } from './crypto-utils.ts';
import type { PadesVerificationResult, PreparedPdf } from './types.ts';

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
   * Cryptographically verifies a PAdES signed PDF:
   * - Extracts ByteRange and /Contents.
   * - Reconstructs the signed byte stream and computes its SHA-256 hash.
   * - Parses the CMS SignedData structure and X.509 signer certificate.
   * - Verifies the signature using pkijs / WebCrypto.
   * - Confirms that no byte outside the signature was altered.
   */
  async verifyPadesSignature(
    pdfBuffer: Buffer,
    trustedCerts?: pkijs.Certificate[]
  ): Promise<PadesVerificationResult> {
    try {
      const extracted = extractSignature(pdfBuffer);
      const calculatedDigestHex = crypto
        .createHash('sha256')
        .update(extracted.signedData)
        .digest('hex');

      const sigDer = Buffer.from(extracted.signature, 'binary');
      const sigAsn1 = asn1js.fromBER(
        sigDer.buffer.slice(
          sigDer.byteOffset,
          sigDer.byteOffset + sigDer.byteLength
        )
      );

      if (!sigAsn1.result) {
        return {
          isValid: false,
          signerName: 'Desconhecido',
          signerCpf: null,
          certificateSubject: '',
          certificateIssuer: '',
          certificateSerial: '',
          certificateFingerprint: '',
          validFrom: new Date(0),
          validTo: new Date(0),
          digestAlgorithm: 'SHA-256',
          messageDigestHex: '',
          calculatedDigestHex,
          error: 'Falha ao decodificar estrutura ASN.1 da assinatura CMS',
        };
      }

      const contentInfo = new pkijs.ContentInfo({ schema: sigAsn1.result });
      const signedData = new pkijs.SignedData({ schema: contentInfo.content });

      // Find signer certificate
      const certificates = signedData.certificates || [];
      let signerCert: pkijs.Certificate | undefined;

      const signerInfo = signedData.signerInfos[0];
      if (signerInfo?.sid && certificates.length > 0) {
        const sid = signerInfo.sid;
        if ('serialNumber' in sid && sid.serialNumber) {
          signerCert = certificates.find((c) => {
            if (c instanceof pkijs.Certificate) {
              return c.serialNumber.isEqual(sid.serialNumber as asn1js.Integer);
            }
            return false;
          }) as pkijs.Certificate | undefined;
        }
      }

      if (!signerCert && certificates[0] instanceof pkijs.Certificate) {
        signerCert = certificates[0];
      }

      if (!signerCert) {
        return {
          isValid: false,
          signerName: 'Desconhecido',
          signerCpf: null,
          certificateSubject: '',
          certificateIssuer: '',
          certificateSerial: '',
          certificateFingerprint: '',
          validFrom: new Date(0),
          validTo: new Date(0),
          digestAlgorithm: 'SHA-256',
          messageDigestHex: '',
          calculatedDigestHex,
          error: 'Nenhum certificado de signatário encontrado na assinatura CMS',
        };
      }

      // Parse certificate details
      const certDer = Buffer.from(signerCert.toSchema().toBER());
      const certInfo = parseX509Certificate(certDer);

      // Verifica a assinatura CMS: messageDigest dos bytes assinados e assinatura
      // sobre os atributos assinados, com a chave do certificado do signatário.
      // Não há alternativa que dispense essa conferência criptográfica.
      let isValid = false;
      let verifyError = '';
      try {
        const result = await signedData.verify({
          signer: 0,
          data: extracted.signedData.buffer.slice(
            extracted.signedData.byteOffset,
            extracted.signedData.byteOffset + extracted.signedData.byteLength
          ),
          checkChain: Boolean(trustedCerts?.length),
          trustedCerts: trustedCerts?.length ? trustedCerts : undefined,
          extendedMode: true,
        });
        isValid = Boolean(result.signatureVerified);
        if (!isValid) verifyError = result.message || 'Assinatura inválida';
      } catch (err) {
        verifyError =
          (err as { message?: string })?.message || 'Assinatura inválida';
      }

      return {
        isValid: Boolean(isValid),
        signerName: certInfo.commonName,
        signerCpf: certInfo.cpf,
        certificateSubject: certInfo.subject,
        certificateIssuer: certInfo.issuer,
        certificateSerial: certInfo.serialNumber,
        certificateFingerprint: certInfo.fingerprint256,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo,
        digestAlgorithm: 'SHA-256',
        messageDigestHex: calculatedDigestHex,
        calculatedDigestHex,
        signedAt: new Date(),
        error: isValid ? undefined : verifyError,
      };
    } catch (err) {
      return {
        isValid: false,
        signerName: 'Desconhecido',
        signerCpf: null,
        certificateSubject: '',
        certificateIssuer: '',
        certificateSerial: '',
        certificateFingerprint: '',
        validFrom: new Date(0),
        validTo: new Date(0),
        digestAlgorithm: 'SHA-256',
        messageDigestHex: '',
        calculatedDigestHex: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const padesService = new PadesService();
