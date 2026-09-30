#!/usr/bin/env node
// Gera os catálogos de diagnóstico a partir das fontes oficiais:
//  - CID-10 em português (DATASUS, versão 2008)
//  - CID-11 MMS em português (OMS, SimpleTabulation)
//  - Tabelas de correspondência CID-10 ↔ CID-11 (OMS)
// Uso: node scripts/update-cid.mjs [release]   (padrão: 2025-01)
// Cada release da CID-11 gera arquivos próprios; releases antigas não são sobrescritas.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const release = process.argv[2] || '2025-01';
const out = new URL('../lib/cid/data/', import.meta.url).pathname;
const sources = {
  cid10: 'http://www2.datasus.gov.br/cid10/V2008/downloads/CID10CSV.zip',
  icd11: `https://icdcdn.who.int/static/releasefiles/${release}/SimpleTabulation-ICD-11-MMS-pt.zip`,
  mapping: `https://icdcdn.who.int/static/releasefiles/${release}/mapping.zip`,
};

const work = mkdtempSync(join(tmpdir(), 'cid-'));
async function fetchZip(name, url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const file = join(work, `${name}.zip`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  const dir = join(work, name);
  execFileSync('unzip', ['-q', '-o', file, '-d', dir]);
  return dir;
}
const unquote = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"');
const tsv = (file) =>
  readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\t'));

try {
  // CID-10: categorias (A00) e subcategorias (A00.0), arquivos em Latin-1.
  const d10 = await fetchZip('cid10', sources.cid10);
  const latin = (f) =>
    new TextDecoder('latin1')
      .decode(readFileSync(join(d10, f)))
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(';'));
  const cid10 = [];
  for (const [code, , title] of latin('CID-10-CATEGORIAS.CSV'))
    cid10.push([code, title.trim()]);
  for (const [code, , , , title] of latin('CID-10-SUBCATEGORIAS.CSV'))
    if (code.length === 4)
      cid10.push([`${code.slice(0, 3)}.${code.slice(3)}`, title.trim()]);
  cid10.sort((a, b) => a[0].localeCompare(b[0]));

  // CID-11: apenas entidades com código; o pai é a categoria codificada mais próxima.
  const d11 = await fetchZip('icd11', sources.icd11);
  const tab = readdirSync(d11).find((f) => f.endsWith('-pt.txt'));
  const icd11 = [];
  const stack = [];
  for (const row of tsv(join(d11, tab)).slice(1)) {
    const code = row[2],
      raw = unquote(row[5] || row[4] || '');
    const depth = (raw.match(/^(- )*/)?.[0].length || 0) / 2;
    stack.length = depth;
    if (!code) {
      stack[depth] = stack[depth - 1] ?? null;
      continue;
    }
    icd11.push([code, raw.replace(/^(- )*/, '').trim(), stack[depth - 1] ?? null]);
    stack[depth] = code;
  }
  const known11 = new Set(icd11.map((x) => x[0]));

  // Correspondências: direta (10→11, múltiplas) e reversa (11→10).
  const dm = await fetchZip('mapping', sources.mapping);
  const forward = {},
    reverse = {};
  const add = (obj, k, v) => {
    if (!k || !v || !known11.has(v)) return;
    const list = (obj[k] ||= []);
    if (!list.includes(v)) list.push(v);
  };
  for (const r of tsv(join(dm, '10To11MapToMultipleCategories.txt')).slice(1))
    if (r[0] === 'category') add(forward, r[2], r[9]);
  for (const r of tsv(join(dm, '11To10MapToOneCategory.txt')).slice(1))
    add(reverse, r[4], r[1]);

  const header = {
    release,
    sources,
    license:
      'CID-10: DATASUS/Ministério da Saúde. CID-11 e tabelas de correspondência: © Organização Mundial da Saúde, CC BY-ND 3.0 IGO.',
  };
  writeFileSync(join(out, 'cid10.json'), JSON.stringify({ ...header, release: '2008', codes: cid10 }));
  writeFileSync(join(out, `icd11-${release}.json`), JSON.stringify({ ...header, codes: icd11 }));
  writeFileSync(join(out, `map10to11-${release}.json`), JSON.stringify({ ...header, forward, reverse }));
  console.log(
    `CID-10: ${cid10.length} códigos · CID-11 ${release}: ${icd11.length} códigos · mapa: ${Object.keys(forward).length} origens`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
