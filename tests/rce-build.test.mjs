// Exercita o bundle Next de produção com HTTP inteiramente interceptado.
// O build de produção deve manter a RCE eletrônica bloqueada, inclusive se
// alguém configurar as flags locais. Confere também os assets do standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { syntheticRce } from './helpers/rce-fixture.mjs';

const keys = ['NODE_ENV', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'PSYWRITE_SNCR_MODE', 'ANVISA_SNCR_ENV'];
const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const oldFetch = globalThis.fetch;
Object.assign(process.env, { NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', SUPABASE_SECRET_KEY: 'synthetic-server', PSYWRITE_SNCR_MODE: 'local-simulation', ANVISA_SNCR_ENV: 'hmg' });
const clinic = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222';
let doc = { ...syntheticRce, clinic_id: clinic, author_id: user, status: 'DRAFT' };
let paths = [];
const signed = new Uint8Array(await readFile('output/pdf/lote5a/rce-assinada-simulada.pdf'));
const hash = createHash('sha256').update(signed).digest('hex');
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  assert.equal(url.origin, 'http://127.0.0.1:54321', 'HTTP não interceptado bloqueado');
  paths.push(url.pathname);
  const reply = data => Response.json(data);
  switch (url.pathname) {
    case '/auth/v1/user': return reply({ id: user, aud: 'authenticated' });
    case '/rest/v1/clinic_members': return reply([{ clinic_id: clinic, role: 'doctor' }]);
    case '/rest/v1/rpc/session_is_strong': return reply(true);
    case '/rest/v1/clinical_documents': return reply(doc);
    case '/rest/v1/patients': return reply({ cpf: syntheticRce.patient_cpf, street: 'Rua Sintética', address_number: '100', city: syntheticRce.patient_city, state: 'SP' });
    case '/rest/v1/document_profiles': return reply({ letterhead_address: syntheticRce.letterhead_address, letterhead_phone: syntheticRce.letterhead_phone });
    case '/rest/v1/digital_signatures': return reply([{ signed_pdf_hash: hash, signed_pdf_storage_path: doc.signed_pdf_path }]);
    default:
      if (url.pathname.startsWith('/storage/v1/object/')) return new Response(signed, { headers: { 'Content-Type': 'application/pdf' } });
      throw new Error(`Chamada inesperada bloqueada: ${url.pathname}`);
  }
};
try {
  const require = createRequire(import.meta.url);
  const get = require('../.next/server/app/api/documents/route.js').routeModule.userland.GET;
  const sign = require('../.next/server/app/api/digital-signature/sign/route.js').routeModule.userland.POST;
  const headers = { authorization: 'Bearer synthetic-only', 'x-signature-action': '1', 'content-type': 'application/json' };
  const request = () => new Request(`http://localhost/api/documents?action=pdf&patientId=${doc.patient_id}&id=${doc.id}`, { headers });
  await test('bundle inclui o modelo oficial e as duas fontes nas duas rotas e no standalone', async () => {
    for (const route of ['documents', 'digital-signature/sign']) {
      const file = `.next/server/app/api/${route}/route.js.nft.json`;
      const files = JSON.parse(await readFile(file, 'utf8')).files.map(f => resolve(dirname(file), f));
      for (const asset of ['assets/sncr/rce-eletronica-anvisa-2026-06-24.pdf', 'assets/fonts/LiberationSans-Regular.ttf', 'assets/fonts/LiberationSans-Bold.ttf']) {
        assert.ok(files.includes(resolve(asset)));
        assert.deepEqual(await readFile(`.next/standalone/${asset}`), await readFile(asset));
      }
    }
  });
  await test('rota compilada exige login antes de buscar qualquer documento', async () => {
    paths = [];
    const res = await get(new Request('http://localhost/api/documents?action=pdf'));
    assert.equal(res.status, 401);
    assert.deepEqual(paths, []);
  });
  await test('rota compilada preserva PDF de papel fora da simulação local', async () => {
    const res = await get(request());
    assert.equal(res.status, 200);
    assert.equal((await PDFDocument.load(await res.arrayBuffer())).getPageCount(), 2);
  });
  await test('rota compilada bloqueia emissão controlada antes de sessão Bird ID ou RPC de reserva', async () => {
    paths = [];
    const res = await sign(new Request('http://localhost/api/digital-signature/sign', { method: 'POST', headers, body: JSON.stringify({ documentId: doc.id }) }));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /bloqueada/i);
    assert.ok(!paths.some(p => p.includes('signature_sessions') || p.includes('sncr_')));
  });
  await test('rota compilada devolve a RCE assinada original sem regenerar nem enriquecer dados', async () => {
    doc = { ...doc, status: 'SIGNED', signed_pdf_path: `${clinic}/sncr-simulations/original.pdf` };
    paths = [];
    const res = await get(request());
    assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), signed);
    assert.ok(!paths.some(p => p.includes('/patients') || p.includes('/document_profiles')));
  });
} finally {
  globalThis.fetch = oldFetch;
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}
