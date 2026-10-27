import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { documentPdf } from '../lib/document-pdf.ts';

const base = {
  id: 'synthetic', patient_id: 'patient', patient_name: 'Paciente Exemplo',
  physician_name: 'Médica Exemplo', physician_registration: 'CRM 12345 SP',
  kind: 'Receita', document_date: '2026-10-27', version: 1,
};
const readStream = (stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
async function inspect(bytes) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'));
    const maps = new Map();
    for (const key of fonts.keys()) {
      const font = fonts.lookup(key);
      const cmap = readStream(font.lookup(PDFName.of('ToUnicode')));
      const entries = new Map();
      for (const section of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const m of section[1].matchAll(/<([0-9A-F]+)>\s*<([0-9A-F]+)>/gi))
          entries.set(m[1].toUpperCase(), String.fromCodePoint(parseInt(m[2], 16)));
      }
      maps.set(key.toString(), entries);
    }
    const content = page.node.Contents();
    const refs = content instanceof PDFArray ? content.asArray() : [content];
    const source = refs.map((r) => readStream(pdf.context.lookup(r))).join('\n');
    const blocks = [];
    for (const match of source.matchAll(/BT\s+([\s\S]*?)\s+ET/g)) {
      const block = match[1];
      const font = block.match(/(\/[^\s]+)\s+[\d.]+\s+Tf/);
      const tm = block.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
      const glyphs = block.match(/<([0-9A-F]*)>\s+Tj/i);
      if (!font || !tm || !glyphs) continue;
      const map = maps.get(font[1]);
      const chars = glyphs[1].match(/.{4}/g) || [];
      blocks.push({ text: chars.map((c) => { const result = map.get(c.toUpperCase()); assert.notEqual(result, undefined); return result; }).join(''), x: Number(tm[1]), y: Number(tm[2]) });
    }
    return blocks;
  });
}
const simple = (body) => ({ ...base, text: `Modalidade: Receita simples\nVia de administração: Uso oral\n\n${body}` });
const medical = (count) => Array.from({ length: count }, (_, i) => `MED${String(i + 1).padStart(3, '0')} - Dose e instrução ${i + 1}`);
const flatten = (pages) => pages.flatMap((page) => page.map((block) => block.text));

describe('integridade e paginação de receitas', () => {
  it('preserva receita simples curta em uma página e ordem dos medicamentos', async () => {
    const lines = medical(3), pages = await inspect(await documentPdf(simple(lines.join('\n'))));
    assert.equal(pages.length, 1);
    assert.deepEqual(flatten(pages).filter((s) => s.startsWith('MED')), lines);
  });
  it('preserva 75 linhas acentuadas, em ordem, sem duplicação ou sobreposição', async () => {
    const lines = medical(75), pages = await inspect(await documentPdf(simple(lines.join('\n'))));
    assert.ok(pages.length > 2);
    assert.deepEqual(flatten(pages).filter((s) => s.startsWith('MED')), lines);
    for (const page of pages) {
      const body = page.filter((b) => b.text.startsWith('MED'));
      for (const b of body) assert.ok(b.x >= 51 && b.y >= 150, `fora da área segura: ${b.text} y=${b.y}`);
      for (let i = 1; i < body.length; i++) assert.ok(body[i-1].y - body[i].y >= 10, 'linhas sobrepostas');
    }
  });
  it('divide palavras sem espaços e linhas extensas sem perder caracteres', async () => {
    const word = 'ação'.repeat(1000), text = `COMECO ${word} FIM`;
    const pages = await inspect(await documentPdf(simple(text)));
    const content = flatten(pages).filter((s) => /^(?:COMECO)?[ação\s]*(?:FIM)?$/.test(s)).join('').replace(/\s/g, '');
    assert.ok(content.includes(text.replace(/\s/g, '')));
    assert.ok(pages.length >= 2);
  });
  it('preserva quebras explícitas e blocos ordenados de cada via', async () => {
    const lines = medical(40);
    const text = `Modalidade: Controle especial\nVia de administração: Uso oral\n\n${lines.slice(0, 20).join('\n')}\n\n${lines.slice(20).join('\n')}`;
    const pages = await inspect(await documentPdf({ ...base, text }));
    assert.ok(pages.length >= 4);
    assert.deepEqual(flatten(pages).filter((s) => s.startsWith('MED')), [...lines, ...lines]);
    const blocks = pages.flat(); const before = blocks.find((b) => b.text.startsWith('MED020')); const after = blocks.find((b) => b.text.startsWith('MED021'));
    if (pages.some((page) => page.includes(before) && page.includes(after))) assert.ok(before.y - after.y >= 20, 'quebra em branco deve ser preservada');
  });
  it('falha explicitamente se nome do paciente não couber no cabeçalho', async () => {
    await assert.rejects(documentPdf({ ...simple('Medicamento'), patient_name: 'Nome '.repeat(100) }), /paciente/i);
  });
});
