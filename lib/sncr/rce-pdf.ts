import { readFile } from 'node:fs/promises';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  type PDFFont,
} from 'pdf-lib';
import QRCode from 'qrcode';
import { validateRceSnapshot, type RceSnapshot } from './rce.ts';

// Original official model, unchanged. Source/hash are documented in assets/sncr/README.md.
export async function rcePdf(
  snapshot: RceSnapshot,
  number: string,
  issuedAt: Date,
  environment: 'hmg',
  templateBytes?: Uint8Array,
) {
  const s = validateRceSnapshot(snapshot);
  if (environment !== 'hmg')
    throw new Error('Emissão em produção ainda não liberada.');
  if (!/^\d{4}\.\d-\d{2}\.\d{7}$/.test(number))
    throw new Error('Formato da numeração ainda não validado.');
  const template = await PDFDocument.load(
    templateBytes ||
      // Same filesystem asset convention as document-pdf.ts. A relative
      // import.meta URL is rewritten to /_next/ by the server webpack bundle.
      (await readFile(
        process.cwd() + '/assets/sncr/rce-eletronica-anvisa.pdf',
      )),
  );
  const result = await PDFDocument.create();
  const font = await result.embedFont(StandardFonts.Helvetica),
    bold = await result.embedFont(StandardFonts.HelveticaBold);
  function lines(text: string, width: number, size: number, f: PDFFont) {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = '';
      for (const word of raw.split(/\s+/).filter(Boolean)) {
        if (f.widthOfTextAtSize(word, size) > width)
          throw new Error(
            'Uma palavra não cabe no modelo da RCE. Revise o texto.',
          );
        if (line && f.widthOfTextAtSize(line + ' ' + word, size) > width) {
          out.push(line);
          line = word;
        } else line = line ? line + ' ' + word : word;
      }
      out.push(line);
    }
    return out;
  }
  const dosage = lines(s.medicine.dosage, 527, 9, font);
  const chunks = Array.from({ length: Math.ceil(dosage.length / 12) }, (_, i) =>
    dosage.slice(i * 12, (i + 1) * 12),
  );
  if (chunks.length > 12)
    throw new Error(
      'Posologia extensa demais. Revise ou divida em novas receitas.',
    );
  // Only the official training entry point is documented for this environment.
  // Do not invent a consultation API/path by copying the production route.
  const consultUrl = 'https://sncr-treinamento.anvisa.gov.br/';
  const qr = await result.embedPng(
    await QRCode.toBuffer(consultUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 200,
    }),
  );
  for (const [index, part] of chunks.entries()) {
    const [page] = await result.copyPages(template, [0]);
    result.addPage(page);
    // The official file's crop starts at y=7.83, rather than zero. Include
    // that origin so added fields align with the visible template labels.
    const height = page.getCropBox().y + page.getHeight();
    const field = (
      text: string,
      x: number,
      top: number,
      width: number,
      maxLines = 2,
      size = 9,
      strong = false,
    ) => {
      const f = strong ? bold : font;
      const wrapped = lines(text, width, size, f);
      if (wrapped.length > maxLines)
        throw new Error(
          'Um campo excede o espaço do modelo da RCE. Revise os dados.',
        );
      wrapped.forEach((line, i) =>
        page.drawText(line, {
          x,
          y: height - top - size - i * 11,
          size,
          font: f,
        }),
      );
    };
    // All coordinates refer to the unmodified official A4 template.
    field(number, 394, 34, 180, 1, 12, true);
    field(s.prescriber.name, 31, 166, 246, 2);
    field(`CRM ${s.prescriber.crm}/${s.prescriber.uf}`, 31, 208, 246, 1);
    field(s.prescriber.address, 31, 248, 246, 2, 8);
    field(s.prescriber.phone, 31, 286, 246, 1);
    field(s.patient.name, 307, 166, 246, 2);
    field(s.patient.identifier, 307, 208, 246, 1);
    field(s.patient.address, 307, 249, 246, 4, 8);
    field(s.medicine.name, 36, 394, 527, 1, 8);
    field(s.medicine.concentration, 145, 408, 410, 1);
    field(s.medicine.pharmaceuticalForm, 181, 438, 375, 1);
    field(s.medicine.quantity, 125, 468, 430, 1);
    part.forEach((line, i) =>
      page.drawText(line, { x: 31, y: height - 530 - i * 11, size: 9, font }),
    );
    // Replace the QR placeholder, preserving the official footer's text.
    page.drawRectangle({
      x: 489,
      y: height - 787,
      width: 76,
      height: 90,
      color: rgb(1, 1, 1),
    });
    page.drawImage(qr, { x: 492, y: height - 780, width: 70, height: 70 });
    field(s.platform, 26, 716, 450, 1, 7);
    field(
      `${s.prescriber.name} - ${issuedAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
      26,
      738,
      450,
      1,
      7,
    );
    field(
      'Consulta de teste: sncr-treinamento.anvisa.gov.br',
      26,
      780,
      450,
      1,
      7,
    );
    page.drawText(
      `HOMOLOGACAO - SEM VALIDADE PARA DISPENSACAO - ${index + 1}/${chunks.length}`,
      {
        x: 72,
        y: 405,
        size: 15,
        font: bold,
        color: rgb(0.75, 0.1, 0.1),
        opacity: 0.32,
        rotate: degrees(35),
      },
    );
  }
  result.setTitle('RCE de teste - sem validade para dispensação');
  return result.save({ useObjectStreams: false });
}
