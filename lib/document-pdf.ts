import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import type { ClinicalDocument } from './document-fields.ts';

const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');

async function prescriptionPdf(
  pdf: PDFDocument,
  d: ClinicalDocument,
  font: PDFFont,
  bold: PDFFont,
) {
  const clinicName = 'CONSULTÓRIO DE PSIQUIATRIA';
  const clinicAddress =
    'Rua Júlio Marcondes Guimarães, nº 115 · Pq Campolim · Sala 506';
  const clinicPhone = 'Tel.: (15) 3233-6216';

  const physicianName = d.physician_name || 'Dr. Guilherme Tayar de Camargo';
  const physicianReg =
    d.physician_registration || 'Psiquiatra  ·  CRM 164119  ·  RQE 72731';

  const dateFormatted = d.document_date
    ? d.document_date.split('-').reverse().join('/')
    : '';

  // Extract via de administração if explicitly present in text
  let viaAdmin = 'Uso oral';
  let bodyText = clean(d.text).trim();
  const viaMatch = bodyText.match(/^via\s+de\s+administra[cç][aã]o:\s*([^\n]+)/i);
  if (viaMatch) {
    viaAdmin = viaMatch[1].trim();
    bodyText = bodyText.slice(viaMatch[0].length).trim();
  }

  const vias = ['1ª via - Farmácia', '2ª via - Paciente'];

  for (const viaTitle of vias) {
    const page = pdf.addPage([595.3, 841.89]);
    const width = 595.3;
    const height = 841.89;
    const left = 51.1;
    const right = width - 51.1;
    const contentWidth = right - left;

    // 1. Header (Consultório & Médico)
    page.drawText(clinicName, {
      x: left,
      y: height - 45.7,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });

    page.drawText(physicianName, {
      x: left,
      y: height - 76.0,
      size: 18,
      font: bold,
      color: rgb(0, 0, 0),
    });

    page.drawText(physicianReg, {
      x: left,
      y: height - 97.0,
      size: 10,
      font: bold,
      color: rgb(0, 0, 0),
    });

    // 2. Title & Via
    page.drawText('Receituário de controle especial', {
      x: left,
      y: height - 132.0,
      size: 17,
      font: bold,
      color: rgb(0, 0, 0),
    });

    page.drawText(viaTitle, {
      x: left,
      y: height - 150.0,
      size: 11,
      font: bold,
      color: rgb(0, 0, 0),
    });

    // 3. Patient Information
    // Line 1: Paciente
    const pLabel = 'Paciente: ';
    const pLabelW = bold.widthOfTextAtSize(pLabel, 10);
    page.drawText(pLabel, {
      x: left,
      y: height - 180.0,
      size: 10,
      font: bold,
      color: rgb(0, 0, 0),
    });
    if (d.patient_name) {
      page.drawText(d.patient_name, {
        x: left + pLabelW,
        y: height - 180.0,
        size: 10,
        font: font,
        color: rgb(0, 0, 0),
      });
      page.drawLine({
        start: {
          x: left + pLabelW + font.widthOfTextAtSize(d.patient_name, 10) + 4,
          y: height - 182,
        },
        end: { x: right, y: height - 182 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    } else {
      page.drawLine({
        start: { x: left + pLabelW, y: height - 182 },
        end: { x: right, y: height - 182 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    // Line 2: Endereço
    const eLabel = 'Endereço: ';
    const eLabelW = bold.widthOfTextAtSize(eLabel, 10);
    page.drawText(eLabel, {
      x: left,
      y: height - 202.0,
      size: 10,
      font: bold,
      color: rgb(0, 0, 0),
    });
    if (d.patient_address) {
      page.drawText(d.patient_address, {
        x: left + eLabelW,
        y: height - 202.0,
        size: 9.5,
        font: font,
        color: rgb(0, 0, 0),
      });
      page.drawLine({
        start: {
          x:
            left +
            eLabelW +
            font.widthOfTextAtSize(d.patient_address, 9.5) +
            4,
          y: height - 204,
        },
        end: { x: right, y: height - 204 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    } else {
      page.drawLine({
        start: { x: left + eLabelW, y: height - 204 },
        end: { x: right, y: height - 204 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    // Line 3: Cidade / UF / Data
    const cLabel = 'Cidade: ';
    const cLabelW = bold.widthOfTextAtSize(cLabel, 9);
    page.drawText(cLabel, {
      x: left,
      y: height - 224.0,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });
    const cityText = d.patient_city || '';
    if (cityText) {
      page.drawText(cityText, {
        x: left + cLabelW,
        y: height - 224.0,
        size: 9,
        font: font,
        color: rgb(0, 0, 0),
      });
    }
    const ufX = left + 270;
    page.drawLine({
      start: {
        x:
          left +
          cLabelW +
          (cityText ? font.widthOfTextAtSize(cityText, 9) + 4 : 0),
        y: height - 226,
      },
      end: { x: ufX - 10, y: height - 226 },
      thickness: 0.5,
      color: rgb(0.2, 0.2, 0.2),
    });

    page.drawText('UF: ', {
      x: ufX,
      y: height - 224.0,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });
    const ufText = d.patient_state || '';
    if (ufText) {
      page.drawText(ufText, {
        x: ufX + 20,
        y: height - 224.0,
        size: 9,
        font: font,
        color: rgb(0, 0, 0),
      });
    }
    const dataX = left + 340;
    page.drawLine({
      start: {
        x: ufX + 20 + (ufText ? font.widthOfTextAtSize(ufText, 9) + 2 : 0),
        y: height - 226,
      },
      end: { x: dataX - 10, y: height - 226 },
      thickness: 0.5,
      color: rgb(0.2, 0.2, 0.2),
    });

    page.drawText('Data: ', {
      x: dataX,
      y: height - 224.0,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });
    if (dateFormatted) {
      page.drawText(dateFormatted, {
        x: dataX + 30,
        y: height - 224.0,
        size: 9,
        font: font,
        color: rgb(0, 0, 0),
      });
    }
    page.drawLine({
      start: {
        x:
          dataX +
          30 +
          (dateFormatted ? font.widthOfTextAtSize(dateFormatted, 9) + 2 : 0),
        y: height - 226,
      },
      end: { x: right, y: height - 226 },
      thickness: 0.5,
      color: rgb(0.2, 0.2, 0.2),
    });

    // 4. Section: PRESCRIÇÃO
    page.drawText('PRESCRIÇÃO', {
      x: left,
      y: height - 249.0,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });

    // Via de administração
    const vLabel = 'Via de administração: ';
    const vLabelW = bold.widthOfTextAtSize(vLabel, 10);
    page.drawText(vLabel, {
      x: left,
      y: height - 269.0,
      size: 10,
      font: bold,
      color: rgb(0, 0, 0),
    });
    if (viaAdmin) {
      page.drawText(viaAdmin, {
        x: left + vLabelW,
        y: height - 269.0,
        size: 10,
        font: font,
        color: rgb(0, 0, 0),
      });
      page.drawLine({
        start: {
          x: left + vLabelW + font.widthOfTextAtSize(viaAdmin, 10) + 4,
          y: height - 271,
        },
        end: { x: right, y: height - 271 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    } else {
      page.drawLine({
        start: { x: left + vLabelW, y: height - 271 },
        end: { x: right, y: height - 271 },
        thickness: 0.5,
        color: rgb(0.2, 0.2, 0.2),
      });
    }

    // Prescription body lines (wrapping long lines)
    let textY = height - 295.0;
    const lines = bodyText.split('\n');
    for (const rawLine of lines) {
      if (textY < height - 460.0) break; // stay within prescription box
      const isHeader =
        rawLine.trim().endsWith(':') ||
        rawLine.trim().toLowerCase().startsWith('orienta');
      const f = isHeader ? bold : font;
      const sz = 9.5;

      if (!rawLine.trim()) {
        textY -= 8;
        continue;
      }

      // Word wrapping
      let currentChunk = '';
      for (const word of rawLine.split(' ')) {
        const testChunk = currentChunk ? currentChunk + ' ' + word : word;
        if (f.widthOfTextAtSize(testChunk, sz) <= contentWidth) {
          currentChunk = testChunk;
        } else {
          if (currentChunk) {
            page.drawText(currentChunk, {
              x: left,
              y: textY,
              size: sz,
              font: f,
              color: rgb(0.05, 0.05, 0.05),
            });
            textY -= 13.5;
          }
          currentChunk = word;
        }
      }
      if (currentChunk) {
        page.drawText(currentChunk, {
          x: left,
          y: textY,
          size: sz,
          font: f,
          color: rgb(0.05, 0.05, 0.05),
        });
        textY -= 14.5;
      }
    }

    // 5. Prescriber Signature block
    const sigLineY = height - 475.0;
    const sigW = 250;
    const sigX = (width - sigW) / 2;
    page.drawLine({
      start: { x: sigX, y: sigLineY },
      end: { x: sigX + sigW, y: sigLineY },
      thickness: 0.5,
      color: rgb(0.2, 0.2, 0.2),
    });
    const sigLabel = 'Assinatura e carimbo do prescritor';
    const sigLabelW = bold.widthOfTextAtSize(sigLabel, 9);
    page.drawText(sigLabel, {
      x: (width - sigLabelW) / 2,
      y: sigLineY - 14.0,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });

    // 6. Dual Boxes: Comprador e Fornecedor
    const boxTop = height - 515.0;
    const boxHeight = 150.0;
    const boxBottom = boxTop - boxHeight;
    const colMid = left + contentWidth / 2;

    // Outer border
    page.drawRectangle({
      x: left,
      y: boxBottom,
      width: contentWidth,
      height: boxHeight,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 0.5,
      color: rgb(1, 1, 1),
    });

    // Middle separator
    page.drawLine({
      start: { x: colMid, y: boxTop },
      end: { x: colMid, y: boxBottom },
      thickness: 0.5,
      color: rgb(0.75, 0.75, 0.75),
    });

    // Column 1: IDENTIFICAÇÃO DO COMPRADOR
    const cLeft = left + 10;
    const cRight = colMid - 10;
    page.drawText('IDENTIFICAÇÃO DO COMPRADOR', {
      x: cLeft,
      y: boxTop - 16,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });

    page.drawText('Nome: ', {
      x: cLeft,
      y: boxTop - 36,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 35, y: boxTop - 38 },
      end: { x: cRight, y: boxTop - 38 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('RG: ', {
      x: cLeft,
      y: boxTop - 56,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 22, y: boxTop - 58 },
      end: { x: cLeft + 110, y: boxTop - 58 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('Órgão emissor: ', {
      x: cLeft + 116,
      y: boxTop - 56,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 185, y: boxTop - 58 },
      end: { x: cRight, y: boxTop - 58 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('Endereço: ', {
      x: cLeft,
      y: boxTop - 76,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 50, y: boxTop - 78 },
      end: { x: cRight, y: boxTop - 78 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });
    page.drawLine({
      start: { x: cLeft, y: boxTop - 96 },
      end: { x: cRight, y: boxTop - 96 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('Cidade: ', {
      x: cLeft,
      y: boxTop - 116,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 40, y: boxTop - 118 },
      end: { x: cLeft + 155, y: boxTop - 118 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('UF: ', {
      x: cLeft + 162,
      y: boxTop - 116,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 182, y: boxTop - 118 },
      end: { x: cRight, y: boxTop - 118 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    page.drawText('Telefone: (____) ', {
      x: cLeft,
      y: boxTop - 136,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });
    page.drawLine({
      start: { x: cLeft + 75, y: boxTop - 138 },
      end: { x: cRight, y: boxTop - 138 },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });

    // Column 2: IDENTIFICAÇÃO DO FORNECEDOR
    const fLeft = colMid + 10;
    const fRight = right - 10;
    page.drawText('IDENTIFICAÇÃO DO FORNECEDOR', {
      x: fLeft,
      y: boxTop - 16,
      size: 9,
      font: bold,
      color: rgb(0, 0, 0),
    });

    page.drawText('Estabelecimento / carimbo', {
      x: fLeft,
      y: boxTop - 36,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });

    const pharmSigY = boxTop - 96;
    page.drawLine({
      start: { x: fLeft, y: pharmSigY },
      end: { x: fRight, y: pharmSigY },
      thickness: 0.5,
      color: rgb(0.4, 0.4, 0.4),
    });
    page.drawText('Assinatura do farmacêutico', {
      x: fLeft,
      y: pharmSigY - 12,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });

    page.drawText('Data: ______/______/____________', {
      x: fLeft,
      y: boxTop - 136,
      size: 8.5,
      font: font,
      color: rgb(0, 0, 0),
    });

    // 7. Footer (Consultório address and phone)
    const footLine1W = font.widthOfTextAtSize(clinicAddress, 9);
    page.drawText(clinicAddress, {
      x: (width - footLine1W) / 2,
      y: 40.0,
      size: 9,
      font: font,
      color: rgb(0.15, 0.15, 0.15),
    });

    const footLine2W = font.widthOfTextAtSize(clinicPhone, 9);
    page.drawText(clinicPhone, {
      x: (width - footLine2W) / 2,
      y: 28.0,
      size: 9,
      font: font,
      color: rgb(0.15, 0.15, 0.15),
    });
  }
}
export async function documentPdf(d: ClinicalDocument) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(
    await readFile(process.cwd() + '/assets/fonts/LiberationSans-Regular.ttf'),
    { subset: true },
  );
  const bold = await pdf.embedFont(
    await readFile(process.cwd() + '/assets/fonts/LiberationSans-Bold.ttf'),
    { subset: true },
  );
  const content = [
    d.kind,
    d.patient_name,
    d.physician_name,
    d.physician_registration,
    d.text,
    d.patient_address || '',
    d.patient_city || '',
    d.patient_state || '',
  ].map(clean);
  const supported = new Set(font.getCharacterSet());
  for (const s of content)
    for (const ch of s.replace(/\n/g, ''))
      if (!supported.has(ch.codePointAt(0)!))
        throw new Error(
          'O PDF contém um caractere não suportado. Remova emojis ou símbolos incomuns e tente novamente.',
        );

  // If this is a prescription, use the official Receituário de controle especial template
  if (d.kind === 'Receita') {
    await prescriptionPdf(pdf, d, font, bold);
    pdf.setTitle('Receituário de controle especial');
    pdf.setCreator('PsyWrite');
    return pdf.save();
  }

  let page = pdf.addPage([595.28, 841.89]),
    y = 780;
  const next = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = 780;
  };
  function line(t: string, size = 11, strong = false) {
    if (y < 85) next();
    page.drawText(t, {
      x: 54,
      y,
      size,
      font: strong ? bold : font,
      color: rgb(0.14, 0.19, 0.17),
    });
    y -= size * 1.55;
  }
  function paragraph(s: string, size = 11, strong = false) {
    const f = strong ? bold : font;
    for (const raw of clean(s).split('\n')) {
      let chunk = '';
      for (const word of raw.split(' ')) {
        const trial = chunk ? chunk + ' ' + word : word;
        if (f.widthOfTextAtSize(trial, size) <= 487) {
          chunk = trial;
          continue;
        }
        if (chunk) line(chunk, size, strong);
        chunk = '';
        for (const ch of word) {
          if (f.widthOfTextAtSize(chunk + ch, size) > 487) {
            line(chunk, size, strong);
            chunk = '';
          }
          chunk += ch;
        }
      }
      line(chunk, size, strong);
    }
  }
  paragraph(d.kind.toUpperCase(), 16, true);
  y -= 12;
  paragraph('Paciente: ' + d.patient_name, 11, true);
  paragraph('Data: ' + (d.document_date || '').split('-').reverse().join('/'));
  y -= 16;
  paragraph(d.text);
  y -= 24;
  paragraph(d.physician_name || 'Nome do médico não informado', 11, true);
  paragraph(
    d.physician_registration || 'Registro profissional não informado',
    10,
  );
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: 54, y: 58 },
      end: { x: 541, y: 58 },
      thickness: 0.5,
      color: rgb(0.8, 0.83, 0.8),
    });
    p.drawText('RASCUNHO - SEM ASSINATURA - SEM VALIDADE CLÍNICA', {
      x: 54,
      y: 42,
      font,
      size: 8,
    });
    p.drawText(`${i + 1} / ${pages.length}`, { x: 505, y: 42, font, size: 8 });
  });
  pdf.setTitle(d.kind);
  pdf.setCreator('PsyWrite');
  return pdf.save();
}
