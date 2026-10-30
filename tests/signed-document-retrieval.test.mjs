import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { documents } from '../lib/supabase/documents.ts';

const savedFetch = globalThis.fetch;
const keys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
const oldEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
after(() => { globalThis.fetch = savedFetch; for (const k of keys) { if (oldEnv[k] === undefined) delete process.env[k]; else process.env[k] = oldEnv[k]; } });
const artifact = new TextEncoder().encode('%PDF-1.7\nsynthetic original signed artifact');
const digest = createHash('sha256').update(artifact).digest('hex');
const base = { id: 'doc-1', clinic_id: 'clinic-1', patient_id: 'patient-1', kind: 'Receita', text: '1) Medicamento', patient_name: 'Paciente Fictício', physician_name: 'Médico Fictício', physician_registration: 'CRM 12345 SP', document_date: '2026-10-27', version: 1, status: 'SIGNED', signed_pdf_path: 'clinic-1/signatures/doc-1.pdf' };
let doc, mode, calls, hash, recordedPath;
function fakeFetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : input);
  calls.push({ path: url.pathname, query: url.search, method: init.method || 'GET' });
  const reply = (v, s = 200) => Response.json(v, { status: s });
  if (url.pathname === '/auth/v1/user') return reply({ id: 'doctor-1', aud: 'authenticated' });
  if (url.pathname === '/rest/v1/clinic_members') return reply([{ clinic_id: 'clinic-1', role: 'doctor' }]);
  if (url.pathname === '/rest/v1/rpc/session_is_strong') return reply(true);
  if (url.pathname === '/rest/v1/clinical_documents') return reply(doc);
  if (url.pathname === '/rest/v1/digital_signatures') {
    if (mode === 'metadata-error') return reply({ message: 'synthetic error' }, 500);
    const pathFilter = url.searchParams.get('signed_pdf_storage_path');
    return reply(hash && (!pathFilter || pathFilter === `eq.${recordedPath}`)
      ? [{ signed_pdf_hash: hash, signed_pdf_storage_path: recordedPath }] : []);
  }
  if (url.pathname === '/rest/v1/patients') return reply({ cpf: '', street: '', city: '', state: '' });
  if (url.pathname === '/rest/v1/document_profiles') return reply(null);
  // RCE eletrônica da main (lib/supabase/documents.ts): nenhuma emissão para o documento.
  if (url.pathname === '/rest/v1/sncr_rce_emissions') return reply(null);
  if (url.pathname.startsWith('/storage/v1/object/')) {
    if (mode === 'network') return Promise.reject(new Error('synthetic storage network error'));
    if (mode === 'missing') return reply({ message: 'not found' }, 404);
    if (mode === 'corrupt') return new Response(new TextEncoder().encode('corrupt bytes'));
    return new Response(artifact, { headers: { 'Content-Type': 'application/pdf' } });
  }
  return reply({ message: 'unexpected fake request' }, 500);
}
const request = () => new Request('https://psywrite.example/api/documents?action=pdf&patientId=patient-1&id=doc-1', { headers: { Authorization: 'Bearer fake' } });

describe('recuperação do artefato assinado', () => {
  beforeEach(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.invalid'; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'fake-public'; process.env.SUPABASE_SECRET_KEY = 'fake-secret'; doc = { ...base }; mode = 'available'; hash = digest; recordedPath = base.signed_pdf_path; calls = []; globalThis.fetch = fakeFetch; });
  it('gera PDF de documento não assinado', async () => { doc.status = 'DRAFT'; const r = await documents(request()); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /pdf/); });
  it('entrega os bytes originais quando o PDF assinado existe', async () => { const r = await documents(request()); assert.equal(r.status, 200); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), artifact); assert.ok(!calls.some((c) => c.path === '/rest/v1/patients')); });
  for (const scenario of ['missing-path', 'missing', 'network', 'read-failure', 'corrupt']) it(`não regenera em falha de recuperação: ${scenario}`, async () => {
    // eslint-disable-next-line typescript/unbound-method -- Captura para restaurar o método no protótipo.
    const original = Blob.prototype.arrayBuffer;
    if (scenario === 'missing-path') doc.signed_pdf_path = null;
    if (scenario === 'missing' || scenario === 'network' || scenario === 'corrupt') mode = scenario;
    if (scenario === 'read-failure') Blob.prototype.arrayBuffer = async () => { throw new Error('synthetic read error'); };
    try { const r = await documents(request()); assert.ok(r.status >= 400); assert.match((await r.json()).error, /assinado/i); assert.ok(!calls.some((c) => c.path === '/rest/v1/patients')); assert.ok(!calls.some((c) => c.method !== 'GET' && !c.path.includes('/rpc/session_is_strong'))); }
    finally { Blob.prototype.arrayBuffer = original; }
  });
  it('documento SUPERSEDED conserva os bytes do original assinado', async () => { doc.status='SUPERSEDED'; const r=await documents(request()); assert.equal(r.status,200); assert.deepEqual(new Uint8Array(await r.arrayBuffer()),artifact); assert.ok(!calls.some(c=>c.path==='/rest/v1/patients')); });
  it('documento SUPERSEDED sem original retorna erro sem regenerar', async () => { doc.status='SUPERSEDED'; doc.signed_pdf_path=null; const r=await documents(request()); assert.equal(r.status,503); assert.ok(!calls.some(c=>c.path==='/rest/v1/patients')); });
  it('admite artefato histórico sem hash cadastrado', async () => { hash = null; const r = await documents(request()); assert.equal(r.status, 200); assert.deepEqual(new Uint8Array(await r.arrayBuffer()), artifact); });
  it('recusa caminho que diverge do registro de assinatura existente', async () => {
    doc.signed_pdf_path = 'clinic-1/signatures/outro.pdf';
    const r = await documents(request());
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /assinado/i);
    assert.ok(!calls.some((c) => c.path.startsWith('/storage/v1/object/')));
  });
  it('recusa entrega quando metadados de assinatura não podem ser consultados', async () => {
    mode = 'metadata-error';
    const r = await documents(request());
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /assinado/i);
  });
});
