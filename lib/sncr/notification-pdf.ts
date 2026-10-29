// Preenche os três PDFs eletrônicos oficiais, sem reconstruir seu desenho.
// Consulta pública documentada pela Anvisa; a geração abaixo continua exclusiva
// da simulação local com reserva sintética validada pelo fluxo de assinatura.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import type { ClinicalDocument } from '../document-fields.ts';
import { parsePrescriptionText } from '../document-fields.ts';
import { parseNotificationFields, notificationApiType, type NotificationModality } from './notification-fields.ts';
import { requireRceValue } from './rce-fields.ts';

export const NOTIFICATION_TEMPLATES: Record<NotificationModality, { path: string; sha256: string }> = {
  notificacao_a: { path: 'assets/sncr/notificacao-a-eletronica-anvisa-2026-06-29.pdf', sha256: 'e72ddb49831615c4b4c652ee9ca0d4f01f131a3896e43512494b16dca6b9f001' },
  notificacao_b: { path: 'assets/sncr/notificacao-b-eletronica-anvisa-2026-06-29.pdf', sha256: '8c7db7622ef8eda963684409da4e0c70ebd7090d5834b7ed7b6f2c05d1f5c7c4' },
  notificacao_b2: { path: 'assets/sncr/notificacao-b2-eletronica-anvisa-2026-06-29.pdf', sha256: '9011a69630f9c42ad0b039aea5d46d05ea082b0a473f48be1445da8cab2c913b' },
};
type Box = { x: number; y: number; width: number; lines: number; size?: number };
const validUfs = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);

export const NOTIFICATION_CONSULTATION_URL = 'https://sncr.anvisa.gov.br/receita/consultar';

export function notificationConsultationUrl(number: string) {
  // Nunca corrigir separadores ou espaços de uma resposta divergente da API.
  if (!/^\d{4}\.\d-\d{2}\.\d{7}$/.test(number) && !/^SIMULADO\.[A-Za-z0-9.-]+$/.test(number))
    throw new Error('Formato da numeração da Notificação incompatível com a consulta SNCR.');
  const url = new URL(NOTIFICATION_CONSULTATION_URL);
  url.searchParams.set('numero', number);
  return url.href;
}

export async function notificationSimulationPdf(doc: ClinicalDocument) {
  if (doc.kind !== 'Receita') throw new Error('Modelo de Notificação exclusivo de receita.');
  const modality = parsePrescriptionText(doc.text).modality;
  if (modality !== 'notificacao_a' && modality !== 'notificacao_b' && modality !== 'notificacao_b2')
    throw new Error('Modalidade incompatível com os modelos de Notificação eletrônica.');
  if (doc.prescription_modality && doc.prescription_modality !== modality)
    throw new Error('Modalidade do documento diverge do texto da Notificação.');
  const fields = parseNotificationFields(doc.text, modality);
  if (!/^SIMULADO\.[A-Za-z0-9.-]+$/.test(doc.sncr_number || ''))
    throw new Error('Notificação local exige número sintético vinculado.');
  const consultationUrl = notificationConsultationUrl(doc.sncr_number!);
  const date = doc.document_date || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    throw new Error('Notificação incompleta: data de emissão inválida ou ausente.');
  const cpf = (doc.patient_cpf || '').replace(/[.\s-]/g, '');
  if (cpf && fields.patientPassport) throw new Error('Notificação: identificação ambígua do paciente.');
  let identity: string;
  if (fields.patientPassport) {
    if (!/^[\p{L}\p{N} -]{3,30}$/u.test(fields.patientPassport)) throw new Error('Notificação: passaporte inválido.');
    identity = `Passaporte: ${fields.patientPassport}`;
  } else {
    requireRceValue(cpf, 'CPF ou passaporte do paciente');
    const digits = cpf.split('').map(Number);
    const check = (length: number) => { const r = digits.slice(0, length).reduce((sum, digit, i) => sum + digit * (length + 1 - i), 0) % 11; return r < 2 ? 0 : 11 - r; };
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf) || digits[9] !== check(9) || digits[10] !== check(10))
      throw new Error('Notificação: CPF do paciente inválido.');
    identity = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }
  const patientAddress = [requireRceValue(doc.patient_address, 'endereço do paciente'), requireRceValue(doc.patient_city, 'cidade do paciente'), requireRceValue(doc.patient_state, 'UF do paciente')].join(' - ');
  if (!validUfs.has(doc.patient_state!)) throw new Error('Notificação: UF do paciente inválida.');
  const template = NOTIFICATION_TEMPLATES[modality];
  const bytes = await readFile(process.cwd() + '/' + template.path);
  if (createHash('sha256').update(bytes).digest('hex') !== template.sha256) throw new Error('Modelo oficial de Notificação divergente da referência revisada.');
  const pdf = await PDFDocument.load(bytes);
  if (pdf.getPageCount() !== 1) throw new Error('Modelo oficial de Notificação inválido.');
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(process.cwd() + '/assets/fonts/LiberationSans-Regular.ttf'), { subset: true });
  const bold = await pdf.embedFont(await readFile(process.cwd() + '/assets/fonts/LiberationSans-Bold.ttf'), { subset: true });
  const supported = new Set(font.getCharacterSet());
  const page = pdf.getPage(0);
  const draw = (raw: string | undefined, label: string, box: Box, face: PDFFont = font) => {
    const value = requireRceValue(raw, label).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    for (const char of value.replace(/\n/g, '')) if (!supported.has(char.codePointAt(0)!)) throw new Error(`Notificação: caractere não suportado em ${label}.`);
    const size = box.size ?? 9;
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
        if (face.widthOfTextAtSize(chunk, size) > box.width) throw new Error(`Notificação: ${label} não cabe no formulário oficial.`);
      }
      lines.push(chunk);
    }
    if (lines.length > box.lines) throw new Error(`Notificação: ${label} excede a área do modelo oficial; nenhum conteúdo foi cortado.`);
    lines.forEach((line, i) => { if (line) page.drawText(line, { x: box.x, y: box.y - i * (size + 2), size, font: face, color: rgb(0, 0, 0) }); });
  };
  draw(doc.sncr_number, 'número SNCR', { x: 402, y: 799, width: 177, lines: 1, size: 8 }, bold);
  draw(doc.physician_name, 'nome do prescritor', { x: 70, y: 658, width: 240, lines: 1 });
  draw(doc.physician_registration, 'inscrição profissional', { x: 70, y: 619, width: 240, lines: 1 });
  draw(doc.letterhead_address, 'endereço do prescritor', { x: 70, y: 580, width: 240, lines: 1 });
  draw(doc.letterhead_phone, 'telefone do prescritor', { x: 70, y: 553, width: 240, lines: 1 });
  draw(doc.patient_name, 'nome do paciente', { x: 334, y: 653, width: 242, lines: 1 });
  draw(identity, 'CPF ou passaporte do paciente', { x: 334, y: 614, width: 242, lines: 1 });
  draw(patientAddress, 'endereço do paciente', { x: 334, y: 575, width: 242, lines: 3 });
  draw(fields.medication, 'medicamento', { x: 72, y: 448, width: 503, lines: 1 });
  draw(fields.concentration, 'concentração', { x: 72, y: 418, width: 503, lines: 1 });
  draw(fields.pharmaceuticalForm, 'forma farmacêutica', { x: 72, y: 388, width: 503, lines: 1 });
  draw(fields.quantity, 'quantidade', { x: 72, y: 358, width: 503, lines: 1 });
  const dosage = `Via de administração: ${fields.route}\n${fields.dosage}` + (fields.guidance ? `\nOrientações complementares:\n${fields.guidance}` : '');
  draw(dosage, 'posologia', { x: 72, y: 326, width: 503, lines: 12 });
  page.drawRectangle({ x: 485, y: 34, width: 100, height: 126, color: rgb(1, 1, 1) });
  const qr = await pdf.embedPng(await QRCode.toBuffer(consultationUrl, { margin: 2, width: 300 }));
  page.drawImage(qr, { x: 503, y: 56, width: 67, height: 67 });
  draw('PsyWrite - simulação local', 'plataforma', { x: 223, y: 126, width: 260, lines: 1, size: 8 });
  draw(`PAdES de teste - emissão ${date.split('-').reverse().join('/')}`, 'registro da assinatura', { x: 234, y: 106, width: 249, lines: 1, size: 8 });
  draw('SIMULACAO LOCAL - SEM VALIDADE CLINICA', 'aviso', { x: 70, y: 746, width: 370, lines: 1, size: 9 }, bold);
  pdf.setTitle(`Notificação de Receita ${notificationApiType[modality].slice(2)} Eletrônica - SIMULAÇÃO LOCAL`);
  pdf.setAuthor('PsyWrite - dados sintéticos');
  pdf.setCreator('PsyWrite');
  pdf.setSubject('Simulação local sem validade clínica; modelo eletrônico Anvisa de junho de 2026');
  pdf.setKeywords([notificationApiType[modality], 'simulação local', 'sem validade clínica']);
  return pdf.save({ useObjectStreams: false });
}
