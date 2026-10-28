// Server only. Preenche o próprio PDF oficial sem reconstruir seu desenho.
// Lote 5A: exclusivamente simulação local; não autoriza emissão real.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import type { ClinicalDocument } from '../document-fields.ts';
import { parseRceFields, requireRceValue } from './rce-fields.ts';

export const RCE_TEMPLATE = 'assets/sncr/rce-eletronica-anvisa-2026-06-24.pdf';
export const RCE_TEMPLATE_SHA256 = '112946ead832ec07f9343f81b35b3571065eb51dea5526cf5c949e0259c11fde';

// Coordenadas medidas no original (A4 595,5 x 842,25 pt), origem inferior.
// Cada caixa inclui margem para ascendente/descendente e rejeita excesso.
type Box = { x: number; y: number; width: number; lines: number; size?: number };
export async function rceSimulationPdf(doc: ClinicalDocument) {
  if (doc.kind !== 'Receita' || (doc.prescription_modality && doc.prescription_modality !== 'controle_especial'))
    throw new Error('Modelo eletrônico RCE exclusivo de controle especial.');
  const fields = parseRceFields(doc.text);
  if (!/^SIMULADO\.[A-Za-z0-9.-]+$/.test(doc.sncr_number || ''))
    throw new Error('RCE local exige número de reserva sintética, sem emissão real.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.document_date || '') ||
      !Number.isFinite(Date.parse(doc.document_date!)) ||
      new Date(doc.document_date!).toISOString().slice(0, 10) !== doc.document_date)
    throw new Error('RCE incompleta: data de emissão inválida ou ausente.');
  const cpf = (doc.patient_cpf || '').replace(/[.\s-]/g, '');
  const passport = fields.patientPassport;
  if (cpf && passport) throw new Error('RCE: identificação ambígua. Use CPF ou passaporte do paciente estrangeiro.');
  let patientIdentity: string;
  if (passport) {
    requireRceValue(passport, 'o passaporte do paciente estrangeiro');
    if (!/^[\p{L}\p{N} -]{3,30}$/u.test(passport)) throw new Error('RCE: passaporte inválido; revise a identificação.');
    patientIdentity = `Passaporte: ${passport}`;
  } else {
    requireRceValue(cpf, 'o CPF ou passaporte do paciente');
    const digits = cpf.split('').map(Number);
    const checkDigit = (length: number) => {
      const remainder = digits.slice(0, length).reduce((sum, digit, i) => sum + digit * (length + 1 - i), 0) % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf) || digits[9] !== checkDigit(9) || digits[10] !== checkDigit(10))
      throw new Error('RCE: CPF do paciente inválido; revise os dígitos no cadastro.');
    patientIdentity = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  const patientAddress = [
    requireRceValue(doc.patient_address, 'o endereço do paciente'),
    requireRceValue(doc.patient_city, 'a cidade do paciente'),
    requireRceValue(doc.patient_state, 'a UF do paciente'),
  ].join(' - ');
  if (!['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'].includes(doc.patient_state!)) throw new Error('RCE: UF do paciente inválida.');
  const template = await readFile(process.cwd() + '/' + RCE_TEMPLATE);
  if (createHash('sha256').update(template).digest('hex') !== RCE_TEMPLATE_SHA256)
    throw new Error('Modelo oficial RCE divergente da referência revisada.');
  const pdf = await PDFDocument.load(template);
  if (pdf.getPageCount() !== 1) throw new Error('Modelo oficial RCE inválido.');
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(process.cwd() + '/assets/fonts/LiberationSans-Regular.ttf'), { subset: true });
  const bold = await pdf.embedFont(await readFile(process.cwd() + '/assets/fonts/LiberationSans-Bold.ttf'), { subset: true });
  const supported = new Set(font.getCharacterSet());
  const page = pdf.getPage(0);
  const draw = (raw: string, label: string, box: Box, face: PDFFont = font) => {
    const value = requireRceValue(raw, label).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    for (const char of value.replace(/\n/g, ''))
      if (!supported.has(char.codePointAt(0)!)) throw new Error(`RCE: caractere não suportado em ${label}; revise sem remover conteúdo automaticamente.`);
    const size = box.size ?? 10;
    const lines: string[] = [];
    for (const rawLine of value.split('\n')) {
      let chunk = '';
      for (const char of rawLine) {
        if (face.widthOfTextAtSize(chunk + char, size) > box.width) {
          const space = chunk.lastIndexOf(' ');
          if (space > 0) { lines.push(chunk.slice(0, space + 1)); chunk = chunk.slice(space + 1); }
          else { lines.push(chunk); chunk = ''; }
        }
        chunk += char;
        if (face.widthOfTextAtSize(chunk, size) > box.width) throw new Error(`RCE: ${label} não cabe no formulário oficial.`);
      }
      lines.push(chunk);
    }
    if (lines.length > box.lines)
      throw new Error(`RCE: ${label} excede a área do modelo oficial. Nenhum conteúdo foi cortado. Revise ou crie outro documento.`);
    lines.forEach((line, i) => { if (line) page.drawText(line, { x: box.x, y: box.y - i * (size + 2), size, font: face, color: rgb(0, 0, 0) }); });
  };
  draw(doc.sncr_number!, 'número SNCR', { x: 402, y: 799, width: 177, lines: 1, size: 8 }, bold);
  draw(doc.physician_name, 'nome do prescritor', { x: 32, y: 674, width: 242, lines: 2, size: 9 });
  draw(doc.physician_registration, 'inscrição profissional', { x: 32, y: 635, width: 242, lines: 2, size: 9 });
  draw(doc.letterhead_address!, 'endereço completo do prescritor', { x: 32, y: 596, width: 242, lines: 2, size: 9 });
  draw(doc.letterhead_phone!, 'telefone do prescritor', { x: 32, y: 556, width: 242, lines: 1, size: 9 });
  draw(doc.patient_name, 'nome do paciente', { x: 307, y: 674, width: 270, lines: 2, size: 9 });
  draw(patientIdentity, 'CPF ou passaporte do paciente', { x: 307, y: 635, width: 270, lines: 1, size: 9 });
  draw(patientAddress, 'endereço completo do paciente', { x: 307, y: 596, width: 270, lines: 4, size: 9 });
  draw(fields.medication, 'medicamento', { x: 36, y: 447, width: 540, lines: 1 });
  draw(fields.concentration, 'concentração', { x: 36, y: 417, width: 540, lines: 1 });
  draw(fields.pharmaceuticalForm, 'forma farmacêutica', { x: 36, y: 387, width: 540, lines: 1 });
  draw(fields.quantity, 'quantidade', { x: 36, y: 357, width: 540, lines: 1 });
  const dosage = `Via de administração: ${fields.route}\n${fields.dosage}` +
    (fields.guidance ? `\nOrientações complementares:\n${fields.guidance}` : '');
  draw(dosage, 'posologia e orientações', { x: 36, y: 316, width: 540, lines: 12 });
  // O original traz apenas uma ilustração de QR: substituir por um QR real
  // do validador público de assinatura, sem alegar validação desta simulação.
  page.drawRectangle({ x: 478, y: 50, width: 100, height: 100, color: rgb(1, 1, 1) });
  const qr = await pdf.embedPng(await QRCode.toBuffer('https://validar.iti.gov.br', { margin: 2, width: 240 }));
  page.drawImage(qr, { x: 491, y: 59, width: 67, height: 67 });
  draw('PsyWrite - simulação local', 'plataforma', { x: 148, y: 137, width: 324, lines: 1, size: 8 });
  draw(`PAdES de teste - emissão ${doc.document_date!.split('-').reverse().join('/')}`, 'registro da assinatura', { x: 181, y: 116, width: 291, lines: 1, size: 8 });
  draw('Simulação: verificação clínica indisponível', 'verificação', { x: 188, y: 73, width: 284, lines: 1, size: 8 });
  draw('SIMULACAO LOCAL - SEM VALIDADE CLINICA', 'aviso', { x: 26, y: 825, width: 550, lines: 1, size: 10 }, bold);
  pdf.setTitle('Receita de Controle Especial Eletrônica - SIMULAÇÃO LOCAL');
  pdf.setAuthor('PsyWrite - dados sintéticos');
  pdf.setCreator('PsyWrite');
  pdf.setSubject('Simulação local sem validade clínica; modelo Anvisa de 24/06/2026');
  pdf.setKeywords(['RCE', 'simulação local', 'sem validade clínica']);
  return pdf.save({ useObjectStreams: false });
}
