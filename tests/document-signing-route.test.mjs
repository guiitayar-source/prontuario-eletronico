// Rota real com autenticação e banco sintéticos. Nenhuma chamada ao PSC ou rede real.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const root = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`), import.meta.url);
const { POST } = await import('../app/api/digital-signature/sign/route.ts');
const { documentSigningService } = await import('../lib/signature/document-signing-service.ts');
const actor = '10000000-0000-4000-8000-000000000001';
const clinic = '20000000-0000-4000-8000-000000000001';
const author = '30000000-0000-4000-8000-000000000001';
const documentId = '40000000-0000-4000-8000-000000000001';
const envKeys = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
const originalAdmin = documentSigningService.documentAdmin;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://synthetic.invalid';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'synthetic-public';
let role = 'doctor', reads = 0;
const audits = [];
globalThis.fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.origin, 'https://synthetic.invalid');
  switch (url.pathname) {
    case '/auth/v1/user': return Response.json({ id: actor, aud: 'authenticated' });
    case '/rest/v1/clinic_members': return Response.json([{ clinic_id: clinic, role }]);
    case '/rest/v1/rpc/session_is_strong': return Response.json(true);
    default: throw Error('HTTP inesperado bloqueado');
  }
};
documentSigningService.documentAdmin = () => ({ from(table) {
  if (table === 'audit_events') return { insert: async row => { audits.push(row); return { error: null }; } };
  assert.equal(table, 'clinical_documents', 'rejeição de autoria deve anteceder sessão/provedor');
  reads++;
  const filters = {};
  const q = { select: () => q, eq: (k, v) => { filters[k] = v; return q; }, maybeSingle: async () => {
    assert.equal(filters.clinic_id, clinic);
    assert.equal(filters.id, documentId);
    return { data: { id: documentId, clinic_id: clinic, author_id: author, version: 1, kind: 'Receita', status: 'DRAFT', text: 'Modalidade: Receita simples' }, error: null };
  } }; return q;
} });
after(() => {
  globalThis.fetch = originalFetch;
  documentSigningService.documentAdmin = originalAdmin;
  for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

for (const memberRole of ['doctor', 'owner']) {
  test(`frontend nao atribui autoria, CPF ou delegacao por body (${memberRole})`, async () => {
    role = memberRole;
    const res = await POST(new Request('https://psywrite.synthetic/api/digital-signature/sign', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'x-signature-action': '1', 'content-type': 'application/json', origin: 'https://psywrite.synthetic' },
      body: JSON.stringify({ documentId, userId: author, author_id: actor, clinicId: clinic, cpf: '52998224725', delegated: true, verification_status: 'VALID' }),
    }));
    assert.equal(res.status, 403);
    const event = audits.at(-1);
    assert.equal(event.actor_id, actor);
    assert.equal(event.context.reason, 'document_author_mismatch');
    assert.ok(!JSON.stringify(event).includes('52998224725'));
  });
}
test('frontend nao pode selecionar clinica da qual nao participa', async () => {
  const before = reads;
  const res = await POST(new Request('https://psywrite.synthetic/api/digital-signature/sign', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-token', 'x-clinic-id': author, 'x-signature-action': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ documentId }),
  }));
  assert.equal(res.status, 403);
  assert.equal(reads, before);
});
