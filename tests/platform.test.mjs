// Painel de assinantes: só as contas em PSYWRITE_ADMIN_USER_IDS entram, e o painel nunca lê
// tabelas clínicas. O Supabase aqui é um fetch falso que registra cada chamada.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Os módulos do servidor importam com "@/" e sem extensão, como o Next permite; o Node não.
const root = pathToFileURL(resolve(import.meta.dirname, '..') + '/').href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      const root = ${JSON.stringify(root)};
      const withTs = (path) => (/\\.[a-z]+$/.test(path) ? path : path + '.ts');
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) return next(root + withTs(specifier.slice(2)), context);
        const ours = context.parentURL?.startsWith(root) && !context.parentURL.includes('/node_modules/');
        if (ours && specifier.startsWith('.'))
          return next(new URL(withTs(specifier), context.parentURL).href, context);
        return next(specifier, context);
      }`),
  import.meta.url,
);

const { isPlatformAdmin, parsePlanFeatures, platform } =
  await import('../lib/supabase/platform.ts');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLINIC = '33333333-3333-4333-8333-333333333333';
const ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'PSYWRITE_ADMIN_USER_IDS',
];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

let calls;
let signedIn;
function fakeSupabase() {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const reply = (data, status = 200) => Response.json(data, { status });
    if (url.pathname === '/auth/v1/user')
      return reply({ id: signedIn, aud: 'authenticated' });
    if (url.pathname === '/rest/v1/clinic_members')
      return reply([{ clinic_id: CLINIC, role: 'owner' }]);
    if (url.pathname === '/rest/v1/rpc/session_is_strong') return reply(true);
    if (url.pathname === '/auth/v1/admin/users')
      return reply({
        users: [
          {
            id: ADMIN,
            email: 'titular@exemplo.com',
            last_sign_in_at: '2026-10-15T10:00:00Z',
          },
        ],
      });
    if (
      url.pathname === '/rest/v1/clinics' &&
      url.search.includes('clinic_members')
    )
      return reply([
        {
          id: CLINIC,
          name: 'Consultório Titular',
          created_at: '2026-10-01T00:00:00Z',
          clinic_features: { features: ['ia'] },
          clinic_members: [{ user_id: ADMIN, role: 'owner' }],
        },
      ]);
    if (url.pathname === '/rest/v1/clinics') return reply({ id: CLINIC });
    if (
      url.pathname === '/rest/v1/clinic_features' ||
      url.pathname === '/rest/v1/audit_events'
    )
      return new Response(null, { status: 201 });
    return reply({ message: 'inesperado' }, 500);
  };
}

const request = (path, init = {}) =>
  new Request('https://psywrite.example' + path, {
    ...init,
    headers: { Authorization: 'Bearer token', ...init.headers },
  });
const post = (action, data, headers = { 'X-Platform-Action': '1' }) =>
  request('/api/platform?action=' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
const serviceCalls = () =>
  calls.filter(
    (c) =>
      ![
        '/auth/v1/user',
        '/rest/v1/clinic_members',
        '/rest/v1/rpc/session_is_strong',
      ].includes(c.path),
  );

describe('painel de assinantes', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publica';
    process.env.SUPABASE_SECRET_KEY = 'secreta';
    process.env.PSYWRITE_ADMIN_USER_IDS = ` ${ADMIN} , `;
    signedIn = ADMIN;
    fakeSupabase();
  });

  it('reconhece só os ids da variável', () => {
    assert.ok(isPlatformAdmin(ADMIN, `${OTHER},${ADMIN}`));
    assert.ok(!isPlatformAdmin(OTHER, ADMIN));
    assert.ok(!isPlatformAdmin(ADMIN, ''));
    assert.ok(!isPlatformAdmin('', ','));
  });

  it('aceita só funções conhecidas, na ordem do catálogo', () => {
    assert.deepEqual(parsePlanFeatures(['anamnesator', 'ia']), [
      'ia',
      'anamnesator',
    ]);
    assert.deepEqual(parsePlanFeatures([]), []);
    assert.throws(() => parsePlanFeatures(['agenda']), { status: 422 });
    assert.throws(() => parsePlanFeatures('ia'), { status: 422 });
  });

  it('para quem não é titular, o painel não existe e nada é lido com a chave de serviço', async () => {
    signedIn = OTHER;
    const me = await platform(request('/api/platform?action=me'));
    assert.deepEqual(await me.json(), { admin: false });
    for (const r of [
      await platform(request('/api/platform')),
      await platform(post('features', { clinic_id: CLINIC, features: ['ia'] })),
      await platform(
        post('provision', { email: 'a@b.com', clinic_name: 'Nova' }),
      ),
    ])
      assert.equal(r.status, 404);
    assert.deepEqual(serviceCalls(), []);
  });

  it('o titular vê as clínicas sem tocar em tabelas clínicas', async () => {
    const me = await platform(request('/api/platform?action=me'));
    assert.deepEqual(await me.json(), { admin: true });
    const r = await platform(request('/api/platform'));
    assert.equal(r.status, 200);
    const { clinics } = await r.json();
    assert.equal(clinics[0].owner, 'titular@exemplo.com');
    assert.deepEqual(clinics[0].features, ['ia']);
    const tables = new Set(serviceCalls().map((c) => c.path));
    assert.deepEqual([...tables].sort(), [
      '/auth/v1/admin/users',
      '/rest/v1/clinics',
    ]);
  });

  it('mudar o plano exige o cabeçalho e grava auditoria com o titular como autor', async () => {
    const blocked = await platform(
      post('features', { clinic_id: CLINIC, features: [] }, {}),
    );
    assert.equal(blocked.status, 403);
    assert.equal(serviceCalls().length, 0);

    const bad = await platform(
      post('features', { clinic_id: 'x', features: [] }),
    );
    assert.equal(bad.status, 400);

    const r = await platform(
      post('features', { clinic_id: CLINIC, features: ['anamnesator', 'ia'] }),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {
      clinicId: CLINIC,
      features: ['ia', 'anamnesator'],
    });
    const upsert = calls.find((c) => c.path === '/rest/v1/clinic_features');
    assert.deepEqual(upsert.body.features, ['ia', 'anamnesator']);
    const audit = calls.find((c) => c.path === '/rest/v1/audit_events');
    assert.equal(audit.body.actor_id, ADMIN);
    assert.equal(audit.body.action, 'clinic_plan_change');
    assert.equal(audit.body.context.via, 'painel do titular');
  });

  it('abrir clínica valida os dados antes de criar qualquer coisa', async () => {
    const r = await platform(
      post('provision', { email: 'sem-arroba', clinic_name: 'Nova' }),
    );
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /e-mail válido/);
    assert.ok(
      !calls.some((c) => c.method === 'POST' && c.path === '/rest/v1/clinics'),
    );
  });
});
