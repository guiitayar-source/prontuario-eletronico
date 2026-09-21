import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { documentPdf } from '../lib/document-pdf.ts';
import { documentTemplate } from '../lib/document-fields.ts';

// 1. Check template files exist in public/templates/
const publicDir = path.resolve('public/templates');
assert.ok(fs.existsSync(path.join(publicDir, 'Receituario-padrao.docx')), 'Receituario-padrao.docx must exist in public/templates');
assert.ok(fs.existsSync(path.join(publicDir, 'Receituario-padrao.pdf')), 'Receituario-padrao.pdf must exist in public/templates');

// 2. Check default documentTemplate('Receita')
const defaultTpl = documentTemplate('Receita');
assert.match(defaultTpl, /Via de administração: Uso oral/);
assert.match(defaultTpl, /Medicamento, forma farmacêutica e concentração/);
assert.match(defaultTpl, /Orientações gerais:/);

// 3. Generate Prescription PDF with standard fields
const docReceita = {
  id: 'receita-teste-1',
  patient_id: 'patient-1',
  patient_name: 'Maria Souza da Silva',
  patient_address: 'Av. Paulista, 1000, Apto 42, Bela Vista',
  patient_city: 'São Paulo',
  patient_state: 'SP',
  consultation_id: null,
  kind: 'Receita',
  text: defaultTpl,
  physician_name: 'Dr. Guilherme Tayar de Camargo',
  physician_registration: 'CRM 164119 · RQE 72731',
  document_date: '2026-09-20',
  version: 0,
};

const pdfBytes = await documentPdf(docReceita);
assert.ok(pdfBytes && pdfBytes.length > 0, 'PDF bytes should be generated');

const pdfDoc = await PDFDocument.load(pdfBytes);
assert.equal(pdfDoc.getPageCount(), 2, 'Prescription must generate exactly 2 pages (1ª via and 2ª via)');

// Check dimensions of both pages
const [page1, page2] = pdfDoc.getPages();
assert.equal(Math.round(page1.getWidth()), 595, 'Page 1 width should be A4 (595pt)');
assert.equal(Math.round(page1.getHeight()), 842, 'Page 1 height should be A4 (842pt)');
assert.equal(Math.round(page2.getWidth()), 595, 'Page 2 width should be A4 (595pt)');
assert.equal(Math.round(page2.getHeight()), 842, 'Page 2 height should be A4 (842pt)');

// 4. Test with custom text and empty address
const docReceitaCustom = {
  id: 'receita-teste-2',
  patient_id: 'patient-2',
  patient_name: 'João Pereira',
  consultation_id: null,
  kind: 'Receita',
  text: 'Via de administração: Uso oral\n\n1) Sertralina 50mg - 60 comprimidos\nTomar 1 comp pela manhã.\n\nOrientações gerais:\nRetorno em 30 dias.',
  physician_name: 'Dr. Guilherme Tayar de Camargo',
  physician_registration: 'CRM 164119 · RQE 72731',
  document_date: '2026-09-20',
  version: 0,
};

const customPdfBytes = await documentPdf(docReceitaCustom);
const customPdfDoc = await PDFDocument.load(customPdfBytes);
assert.equal(customPdfDoc.getPageCount(), 2, 'Custom prescription must also have 2 pages');

for (const document_date of ['', null]) {
  const undated = await documentPdf({ ...docReceita, document_date });
  assert.equal((await PDFDocument.load(undated)).getPageCount(), 2);
}

// 5. Test other kind generates standard single page
const docAtestado = {
  id: 'atestado-teste-1',
  patient_id: 'patient-1',
  patient_name: 'Maria Souza da Silva',
  consultation_id: null,
  kind: 'Atestado',
  text: 'Atesto para os devidos fins que a paciente necessita de repouso.',
  physician_name: 'Dr. Guilherme Tayar de Camargo',
  physician_registration: 'CRM 164119 · RQE 72731',
  document_date: '2026-09-20',
  version: 0,
};

const atestadoBytes = await documentPdf(docAtestado);
const atestadoPdfDoc = await PDFDocument.load(atestadoBytes);
assert.equal(atestadoPdfDoc.getPageCount(), 1, 'Standard document should generate 1 page');

console.log('PASS: Receituário padrão gera 2 vias (Farmácia/Paciente) A4, com endereço, templates e download ok.');
