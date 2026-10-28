import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { rceSimulationPdf, RCE_TEMPLATE } from '../lib/sncr/rce-pdf.ts';
import { parseRceFields, rceElectronicTemplate } from '../lib/sncr/rce-fields.ts';
import { documentPdf } from '../lib/document-pdf.ts';
import { simulationPdf } from '../lib/sncr/signing.ts';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { padesService } from '../lib/signature/pades-service.ts';
import { syntheticRce } from './helpers/rce-fixture.mjs';

const dir = 'output/pdf/lote5a';
await mkdir(dir, { recursive: true });
const original = await PDFDocument.load(await readFile(RCE_TEMPLATE));
let bytes;
function bbox(path) {
  const xml = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
  return [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map(m => ({ x: +m[1], y: +m[2], right: +m[3], bottom: +m[4], text: m[5] }));
}
function assertNoOverlap(path) {
  const source = bbox(RCE_TEMPLATE);
  const same = (a, b) => a.text === b.text && Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01;
  const added = bbox(path).filter(word => !source.some(s => same(s, word)));
  assert.ok(added.length > 10);
  const intersects = (a, b) => Math.min(a.right, b.right) > Math.max(a.x, b.x) && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y);
  for (const a of added) {
    assert.ok(a.x >= 25 && a.right <= 579 && a.y >= 8 && a.bottom <= 807, `fora da página: ${a.text}`);
    for (const b of source) assert.ok(!intersects(a, b), `sobreposição com o modelo oficial: ${a.text} / ${b.text}`);
  }
  for (let i = 0; i < added.length; i++) for (let j = i + 1; j < added.length; j++)
    assert.ok(!intersects(added[i], added[j]), `valores sobrepostos: ${added[i].text} / ${added[j].text}`);
  // Limite inferior do quadro PRESCRIÇÃO no original (coordenada desde o topo).
  for (const a of added.filter(a => a.y > 370 && a.y < 700)) assert.ok(a.bottom < 672, `fora do quadro: ${a.text}`);
}
async function pdfText(data, name = 'rce-teste') {
  const path = `${dir}/${name}.pdf`;
  await writeFile(path, data);
  return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
}
await test('campos explícitos preservam todas as linhas e orientações sem inferência clínica', () => {
  const d = { ...syntheticRce, text: syntheticRce.text.replace('Instrução sintética:', 'Linha A\nLinha B:') };
  const fields = parseRceFields(d.text);
  assert.match(fields.dosage, /Linha A\nLinha B:/);
  assert.match(fields.guidance, /Retorno de teste/);
  assert.equal(fields.route, 'Uso oral');
});
await test('usa os streams originais e as dimensões exatas do PDF oficial, com uma página', async () => {
  bytes = await simulationPdf(syntheticRce);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), original.getPage(0).getSize());
  const streams = p => {
    const contents = p.node.Contents();
    return (contents instanceof PDFArray ? contents.asArray() : [contents])
      .map(ref => Buffer.from(decodePDFRawStream(p.doc.context.lookup(ref)).decode()));
  };
  const generated = streams(pdf.getPage(0));
  for (const source of streams(original.getPage(0))) assert.ok(generated.some(s => s.equals(source)), 'desenho oficial alterado');
  const text = await pdfText(bytes, 'rce-curta-simulada');
  for (const value of ['ELETRÔNICA', 'EMITENTE', 'PACIENTE', 'PRESCRIÇÃO', syntheticRce.sncr_number, 'MED001', '10 mg (teste)', 'Comprimido de teste', '30 (trinta)', 'Instrução sintética:', 'Retorno de teste', 'Uso oral', '28/10/2026', 'validar.iti.gov.br', 'sncr.anvisa.gov.br', 'SIMULACAO LOCAL - SEM VALIDADE CLINICA'])
    assert.ok(text.includes(value), `conteúdo ausente: ${value}`);
  assert.doesNotMatch(text, /IDENTIFICAÇÃO DO COMPRADOR|1ª via|2ª via|Assinatura e carimbo/);
  assertNoOverlap(`${dir}/rce-curta-simulada.pdf`);
});
await test('posologia extensa aceita preserva início, fim, ordem e palavra longa sem espaços', async () => {
  const dosage = Array.from({ length: 9 }, (_, i) => `LINHA${i + 1} - Instrução sintética com acentuação.`).join('\n');
  const long = { ...syntheticRce, patient_name: 'Paciente Sintético com nome extenso para teste de quebra em duas linhas', text: syntheticRce.text.replace('Instrução sintética: usar conforme cenário de teste.', dosage).replace('MED001 - Substância sintética para teste', 'AÇÃO'.repeat(12)) };
  const text = await pdfText(await rceSimulationPdf(long), 'rce-extensa-simulada');
  for (let i = 1; i <= 9; i++) assert.ok(text.indexOf(`LINHA${i}`) > (i === 1 ? 0 : text.indexOf(`LINHA${i - 1}`)));
  assert.ok(text.includes('AÇÃO'.repeat(12)));
  assert.ok(text.includes('Retorno de teste'));
  assertNoOverlap(`${dir}/rce-extensa-simulada.pdf`);
});
await test('aceita passaporte explícito do paciente estrangeiro sem inventar CPF', async () => {
  const d = { ...syntheticRce, patient_cpf: '', text: syntheticRce.text.replace('\n\n', '\nPassaporte do paciente (se estrangeiro): TESTE123\n\n') };
  const data = await rceSimulationPdf(d);
  const pdf = await PDFDocument.load(data);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(parseRceFields(d.text).patientPassport, 'TESTE123');
  await mkdir(`${dir}/tmp`, { recursive: true });
  const path = `${dir}/tmp/passaporte.pdf`;
  await writeFile(path, data);
  const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  assert.match(text, /Passaporte: TESTE123/);
  assert.ok(!text.includes('529.982.247-25'));
  assertNoOverlap(path);
});
for (const field of ['patient_name', 'physician_name', 'physician_registration', 'patient_cpf', 'patient_address', 'patient_city', 'patient_state', 'letterhead_address', 'letterhead_phone', 'document_date']) {
  await test(`rejeita identificação incompleta: ${field}`, async () => {
    await assert.rejects(rceSimulationPdf({ ...syntheticRce, [field]: '' }), /incompleta|preencha|data/i);
  });
}
for (const [name, overrides] of /** @type {[string, object][]} */ ([
  ['CPF inválido', { patient_cpf: '123' }],
  ['CPF com dígito inválido', { patient_cpf: '52998224726' }],
  ['CPF com todos os dígitos iguais', { patient_cpf: '00000000000' }],
  ['CPF e passaporte concorrentes', { text: syntheticRce.text + '\nPassaporte do paciente (se estrangeiro): TESTE123' }],
  ['UF inválida', { patient_state: 'São Paulo' }],
  ['data impossível', { document_date: '2026-02-30' }],
  ['número manual', { sncr_number: '2600.123' }],
  ['número ausente', { sncr_number: undefined }],
  ['texto livre legado', { text: 'Via de administração: Uso oral\n\n1) MED001 10 mg - 30 comprimidos\nUsar no teste' }],
  ['modelo por preencher', { text: rceElectronicTemplate }],
  ['campo duplicado / dois medicamentos', { text: syntheticRce.text + '\nNome do medicamento ou substância: MED002' }],
  ['metadados duplicados', { text: 'Via de administração: Uso oral\n' + syntheticRce.text }],
  ['número no corpo', { text: syntheticRce.text + '\nSNCR: MANUAL' }],
  ['concentração ausente', { text: syntheticRce.text.replace('Concentração: 10 mg (teste)\n', '') }],
  ['via ausente', { text: syntheticRce.text.replace('Via de administração: Uso oral\n', '') }],
  ['símbolo sem glifo', { patient_name: 'Paciente 🧠' }],
  ['controle invisível', { text: syntheticRce.text + '\u202e' }],
  ['nome extenso demais', { patient_name: 'W'.repeat(200) }],
  ['medicamento extenso demais', { text: syntheticRce.text.replace('MED001', 'M'.repeat(300)) }],
  ['posologia que não cabe', { text: syntheticRce.text.replace('Instrução sintética:', 'Linha\n'.repeat(30)) }],
  ['timbre que não cabe', { letterhead_address: 'Endereço '.repeat(80) }],
  ['outra modalidade', { text: 'Modalidade: Retenção\n' + syntheticRce.text }],
  ['modalidade divergente no objeto', { prescription_modality: 'notificacao_b' }],
])) {
  await test(`bloqueia ${name}, sem produzir PDF parcial`, async () => {
    await assert.rejects(rceSimulationPdf({ ...syntheticRce, ...overrides }));
  });
}
await test('assinatura PAdES de teste abrange o PDF inteiro e detecta adulteração', async () => {
  const prepared = await padesService.preparePdfForSignature(bytes, { signerName: 'SIMULACAO LOCAL', drawVisualBox: false });
  const result = await new MockBirdIdProvider({ doctorName: 'SIMULACAO LOCAL' }).signHash({ accessToken: 'synthetic', certificateAlias: 'synthetic', hashHex: prepared.digestHex, documentAlias: 'rce-test' });
  const signed = padesService.embedSignature(prepared, result.cmsSignatureBase64);
  assert.equal((await padesService.verifyPadesSignature(signed)).isValid, true);
  await pdfText(signed, 'rce-assinada-simulada');
  assertNoOverlap(`${dir}/rce-assinada-simulada.pdf`);
  const corrupted = Buffer.from(signed);
  const index = corrupted.indexOf(Buffer.from('/Type'));
  assert.ok(index > 0);
  corrupted[index + 3] ^= 1;
  assert.equal((await padesService.verifyPadesSignature(corrupted)).isValid, false);
});
await test('RCE de papel e demais modalidades conservam o gerador histórico', async () => {
  for (const modality of ['controle_especial', 'simples', 'retencao', 'notificacao_a', 'notificacao_b']) {
    const d = { ...syntheticRce, text: `Modalidade: ${modality}\nVia de administração: Uso oral\n\nMED001 - Texto livre de teste`, prescription_modality: modality, sncr_number: undefined };
    const pdf = await PDFDocument.load(await documentPdf(d));
    assert.equal(pdf.getPageCount(), modality === 'simples' ? 1 : 2);
  }
});
