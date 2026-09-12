import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import type { ClinicalDocument } from './document-fields.ts';
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
  const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const content = [
    d.kind,
    d.patient_name,
    d.physician_name,
    d.physician_registration,
    d.text,
  ].map(clean);
  const supported = new Set(font.getCharacterSet());
  for (const s of content)
    for (const ch of s.replace(/\n/g, ''))
      if (!supported.has(ch.codePointAt(0)!))
        throw new Error(
          'O PDF contém um caractere não suportado. Remova emojis ou símbolos incomuns e tente novamente.',
        );
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
  paragraph('Data: ' + d.document_date.split('-').reverse().join('/'));
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
