// PostgreSQL real e descartável. Apenas o transporte SNCR é um mock contratual explícito.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSncrDb } from './helpers/sncr-local-db.mjs';
import { containerEngine } from './helpers/sncr-container.mjs';
import {
  SncrSessions,
  authOperation,
  captureSncrCallback,
} from '../lib/sncr/sessions.ts';
import {
  sncrAuthConfig,
  SNCR_API,
  cookieValue,
  authCookie,
  AUTH_COOKIE,
  TRANSFER_COOKIE,
} from '../lib/sncr/auth-config.ts';
import {
  randomSecret,
  secretHash,
  sealSession,
  openSession,
} from '../lib/sncr/session-crypto.ts';
import { exchangeSncrSession } from '../lib/sncr/auth-http.ts';
import {
  reserveDocument,
  localSimulationEnabled,
} from '../lib/sncr/numbering.ts';
import { documentPdf } from '../lib/document-pdf.ts';
import { HttpError, json, writeGuard } from '../lib/supabase/server.ts';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';

const keys = [
  'NODE_ENV',
  'PSYWRITE_SNCR_AUTH_MODE',
  'ANVISA_SNCR_ENV',
  'PSYWRITE_SNCR_CALLBACK_URL',
  'SNCR_SESSION_ENCRYPTION_KEY',
  'PSYWRITE_SNCR_MODE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VERCEL',
  'VERCEL_ENV',
  'PSYWRITE_MAINTAINER_LEGAL_NAME',
  'PSYWRITE_MAINTAINER_CNPJ',
];
const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
Object.assign(process.env, {
  NODE_ENV: 'test',
  PSYWRITE_SNCR_AUTH_MODE: 'homologation',
  ANVISA_SNCR_ENV: 'hmg',
  PSYWRITE_SNCR_CALLBACK_URL: 'http://localhost:3000/api/sncr/auth/callback',
  SNCR_SESSION_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  PSYWRITE_SNCR_MODE: 'blocked',
  PSYWRITE_MAINTAINER_LEGAL_NAME: 'Empresa Sintética',
  PSYWRITE_MAINTAINER_CNPJ: '12345678000195',
});
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
const h = createSncrDb();
const migration = readFileSync(
  new URL(
    '../supabase/migrations/20261028010000_sncr_sessions.sql',
    import.meta.url,
  ),
  'utf8',
);
const guard =
  "do $$ begin\n raise exception 'Migração de sessões SNCR em revisão: não aplicar';\nend $$;";
const config = sncrAuthConfig();
const calls = [];
let response = () =>
  Response.json({ access_token: 'synthetic-token-only', token_type: 'Bearer' });
const transport = async (url, options) => {
  calls.push({ url: new URL(url), options });
  return response();
};
const sessions = new SncrSessions(h.db, transport);
function fixture() {
  const actor = { clinicId: randomUUID(), userId: randomUUID() };
  h.sql(
    `insert into clinics values('${actor.clinicId}');insert into auth.users values('${actor.userId}');insert into clinic_members values('${actor.clinicId}','${actor.userId}','doctor');insert into document_profiles(clinic_id,user_id,physician_registration,cpf) values('${actor.clinicId}','${actor.userId}','CRM 12345 SP','12345678909');`,
  );
  return actor;
}
function envelope(started, sid = randomSecret(), query = '') {
  const client = new URL(started.authorizationUrl).searchParams.get(
      'client_url',
    ),
    state = new URL(client).pathname.split('/').at(-1);
  const url = new URL(client);
  if (sid !== null) url.searchParams.set('session_id', sid);
  if (query) url.searchParams.set('error', query);
  return captureSncrCallback(new Request(url), state, started.binding, config);
}
async function login(actor) {
  const start = await sessions.start(actor, config);
  return {
    start,
    result: await sessions.complete(
      actor,
      start.binding,
      envelope(start),
      config,
    ),
  };
}
function route(file, bindings) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(
    'route.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const noImports = ts.factory.updateSourceFile(
    ast,
    ast.statements.filter((s) => !ts.isImportDeclaration(s)),
  );
  const js = ts.transpileModule(ts.createPrinter().printFile(noImports), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports = {};
  runInNewContext(js, {
    exports,
    Request,
    Response,
    Headers,
    URL,
    process,
    ...bindings,
  });
  return exports;
}
try {
  assert.equal(migration.split(guard).length, 2);
  h.sql('alter table document_profiles add column cpf text;');
  h.sql(
    `begin;${migration.replace(guard, '-- cópia exclusivamente descartável')}commit;`,
  );
  await test('login válido usa rota SNCR intermediada e client_url de backend fixo', async () => {
    const actor = fixture(),
      s = await sessions.start(actor, config),
      url = new URL(s.authorizationUrl);
    assert.equal(url.origin, new URL(SNCR_API.hmg).origin);
    assert.ok(url.pathname.endsWith('/api/v1/auth/login'));
    assert.ok(
      url.searchParams.get('client_url').startsWith(config.callback + '/'),
    );
    assert.equal((await sessions.status(actor)).state, 'pending');
    assert.equal(calls.length, 0);
  });
  await test('callback autorizado inclui somente domínio .br HTTPS ou localhost/127 local', () => {
    const base = {
      ...process.env,
      PSYWRITE_SNCR_CALLBACK_URL:
        'https://psywrite.example.br/api/sncr/auth/callback',
    };
    assert.equal(sncrAuthConfig(base).origin, 'https://psywrite.example.br');
    assert.equal(
      sncrAuthConfig({
        ...base,
        PSYWRITE_SNCR_CALLBACK_URL:
          'http://127.0.0.1:8080/api/sncr/auth/callback',
      }).origin,
      'http://127.0.0.1:8080',
    );
  });
  await test('callback malicioso, Vercel preview e overrides de produção são recusados', () => {
    for (const url of [
      'https://app.vercel.app/api/sncr/auth/callback',
      'https://example.br.attacker.com/api/sncr/auth/callback',
      'https://example.br/api/sncr/auth/callback?next=evil',
      'https://user:pass@example.br/api/sncr/auth/callback',
      'http://example.br/api/sncr/auth/callback',
      'https://example.br:444/api/sncr/auth/callback',
      'https://example.br/api/other',
    ])
      assert.throws(() =>
        sncrAuthConfig({ ...process.env, PSYWRITE_SNCR_CALLBACK_URL: url }),
      );
    assert.throws(() => sncrAuthConfig({ ...process.env, VERCEL: '1' }));
    assert.throws(() =>
      sncrAuthConfig({ ...process.env, ANVISA_SNCR_ENV: 'prd' }),
    );
  });
  await test('callback válido troca session_id uma vez com Origin e guarda token cifrado', async () => {
    const actor = fixture(),
      { result } = await login(actor);
    assert.equal(result.state, 'connected');
    assert.equal(result.identityStatus, 'unverified');
    assert.equal(calls.at(-1).options.headers.Origin, config.origin);
    assert.equal(calls.at(-1).options.redirect, 'error');
    assert.equal(calls.at(-1).options.cache, 'no-store');
    const stored = JSON.parse(
      h.sql(
        `select to_jsonb(s) from sncr_user_sessions s where user_id='${actor.userId}';`,
      ),
    );
    assert.ok(stored.token_cipher.startsWith('v1.'));
    assert.ok(!stored.token_cipher.includes('synthetic-token-only'));
    assert.equal(
      openSession(
        stored.token_cipher,
        `${actor.clinicId}:${actor.userId}:hmg:${stored.id}`,
      ),
      'synthetic-token-only',
    );
    assert.throws(() =>
      openSession(
        stored.token_cipher,
        `${actor.clinicId}:another:hmg:${stored.id}`,
      ),
    );
  });
  await test('callback sem session_id e login cancelado não chamam a troca externa', async () => {
    for (const error of ['', 'access_denied']) {
      const actor = fixture(),
        start = await sessions.start(actor, config),
        before = calls.length;
      await assert.rejects(
        () =>
          sessions.complete(
            actor,
            start.binding,
            envelope(start, null, error),
            config,
          ),
        /cancelado|identificador/,
      );
      assert.equal(calls.length, before);
    }
  });
  await test('tentativa expirada é recusada antes de HTTP', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      before = calls.length;
    h.sql(
      `update sncr_login_attempts set expires_at=now()-interval '1s' where user_id='${actor.userId}';`,
    );
    await assert.rejects(() =>
      sessions.complete(actor, start.binding, envelope(start), config),
    );
    assert.equal(calls.length, before);
    assert.equal((await sessions.status(actor)).state, 'expired');
  });
  await test('mesmo session_id não é consumido novamente nem em outra tentativa', async () => {
    const actor = fixture(),
      s = await sessions.start(actor, config),
      sid = randomSecret(),
      transfer = envelope(s, sid);
    await sessions.complete(actor, s.binding, transfer, config);
    const before = calls.length;
    await assert.rejects(() =>
      sessions.complete(actor, s.binding, transfer, config),
    );
    const s2 = await sessions.start(actor, config);
    await assert.rejects(() =>
      sessions.complete(actor, s2.binding, envelope(s2, sid), config),
    );
    assert.equal(calls.length, before);
  });
  await test('callback de outro usuário e cookie trocado não concluem login', async () => {
    const a = fixture(),
      b = fixture(),
      start = await sessions.start(a, config),
      t = envelope(start),
      before = calls.length;
    await assert.rejects(() => sessions.complete(b, start.binding, t, config));
    await assert.rejects(() => sessions.complete(a, randomSecret(), t, config));
    assert.equal(calls.length, before);
  });
  await test('token fica válido por no máximo 30 segundos; JWT decodificado não é prova', async () => {
    const actor = fixture();
    response = () =>
      Response.json({
        access_token:
          'eyJhbGciOiJub25lIn0.eyJjcGYiOiIxMjM0NTY3ODkwOSIsImV4cCI6OTk5OTk5OTk5OX0.x',
        token_type: 'Bearer',
      });
    try {
      const { result } = await login(actor);
      assert.ok(Date.parse(result.expiresAt) <= Date.now() + 30000);
      assert.equal(result.identityStatus, 'unverified');
      await assert.rejects(
        () => sessions.numberingIdentity(actor, 'hmg', 'CRM 12345 SP'),
        /não comprovada/,
      );
    } finally {
      response = () =>
        Response.json({
          access_token: 'synthetic-token-only',
          token_type: 'Bearer',
        });
    }
  });
  await test('token expirado é apagado e não permite operações', async () => {
    const actor = fixture();
    await login(actor);
    h.sql(
      `update sncr_user_sessions set expires_at=now()-interval '1s' where user_id='${actor.userId}';`,
    );
    assert.equal((await sessions.status(actor)).state, 'expired');
    assert.equal(
      h.sql(
        `select token_cipher is null from sncr_user_sessions where user_id='${actor.userId}';`,
      ),
      't',
    );
    await assert.rejects(
      () => sessions.numberingIdentity(actor, 'hmg', 'CRM 12345 SP'),
      /novamente/,
    );
  });
  for (const code of [401, 403])
    await test(`falha HTTP ${code} é específica, sem token provisório ou retry`, async () => {
      const actor = fixture(),
        start = await sessions.start(actor, config),
        before = calls.length;
      response = () =>
        new Response('SENSITIVE_UPSTREAM_ERROR', { status: code });
      try {
        await assert.rejects(
          () =>
            sessions.complete(actor, start.binding, envelope(start), config),
          (e) => e.status === code && !e.message.includes('SENSITIVE'),
        );
        assert.equal(calls.length, before + 1);
        assert.equal((await sessions.status(actor)).state, 'failed');
      } finally {
        response = () =>
          Response.json({
            access_token: 'synthetic-token-only',
            token_type: 'Bearer',
          });
      }
    });
  await test('falha de comunicação/timeout preserva resultado incerto e não repete troca', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      t = envelope(start),
      before = calls.length;
    response = () => {
      throw Error('SENSITIVE_NETWORK_DETAIL');
    };
    try {
      await assert.rejects(
        () => sessions.complete(actor, start.binding, t, config),
        /incerto/,
      );
      assert.equal((await sessions.status(actor)).state, 'uncertain');
      await assert.rejects(() =>
        sessions.complete(actor, start.binding, t, config),
      );
      assert.equal(calls.length, before + 1);
    } finally {
      response = () =>
        Response.json({
          access_token: 'synthetic-token-only',
          token_type: 'Bearer',
        });
    }
  });
  await test('dois médicos simultâneos mantêm tokens e tentativas isolados', async () => {
    const a = fixture(),
      b = fixture();
    await Promise.all([login(a), login(b)]);
    const rows = JSON.parse(
      h.sql(
        `select jsonb_agg(to_jsonb(s)) from sncr_user_sessions s where user_id in ('${a.userId}','${b.userId}');`,
      ),
    );
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.notEqual(rows[0].token_cipher, rows[1].token_cipher);
  });
  await test('troca de perfil/CRM invalida a sessão sem assumir identidade oficial', async () => {
    const actor = fixture();
    await login(actor);
    await assert.rejects(
      () => sessions.numberingIdentity(actor, 'hmg', 'CRM 99999 SP'),
      /Inscrição incompatível/,
    );
    h.sql(
      `update document_profiles set physician_registration='CRM 99999 SP' where user_id='${actor.userId}';`,
    );
    assert.equal((await sessions.status(actor)).state, 'identity_mismatch');
    assert.equal(
      h.sql(
        `select token_cipher is null from sncr_user_sessions where user_id='${actor.userId}';`,
      ),
      't',
    );
  });
  await test('hmg e prd têm armazenamento isolado e login de produção continua desabilitado', async () => {
    const actor = fixture();
    await login(actor);
    assert.equal((await sessions.status(actor, 'prd')).state, 'disconnected');
    await sessions.disconnect(actor, 'prd');
    assert.equal((await sessions.status(actor, 'hmg')).state, 'connected');
    assert.throws(() =>
      sncrAuthConfig({ ...process.env, ANVISA_SNCR_ENV: 'prd' }),
    );
  });
  await test('logout local de um médico não desconecta outro nem revoga externamente', async () => {
    const a = fixture(),
      b = fixture();
    await login(a);
    await login(b);
    const before = calls.length;
    await sessions.disconnect(a);
    assert.equal((await sessions.status(a)).state, 'disconnected');
    assert.equal((await sessions.status(b)).state, 'connected');
    assert.equal(calls.length, before);
  });
  await test('usuário interno sem sessão SNCR e identidade não comprovada bloqueiam numeração', async () => {
    const actor = fixture();
    await assert.rejects(
      () => sessions.numberingIdentity(actor, 'hmg', 'CRM 12345 SP'),
      /novamente/,
    );
    await login(actor);
    await assert.rejects(
      () => sessions.numberingIdentity(actor, 'hmg', 'CRM 12345 SP'),
      /não comprovada/,
    );
  });
  await test('backend de reserva usa inscrição persistida e mantém emissão real bloqueada', async () => {
    const actor = fixture(),
      id = randomUUID();
    h.sql(
      `insert into clinical_documents(id,clinic_id,author_id,patient_id,kind,status,physician_registration,version,text,patient_name,physician_name) values('${id}','${actor.clinicId}','${actor.userId}','synthetic','Receita','DRAFT','CRM 12345 SP',1,'MED001','Sintético','Sintético');`,
    );
    await assert.rejects(() => reserveDocument(h.db, actor, id), /novamente/);
    await login(actor);
    await assert.rejects(
      () => reserveDocument(h.db, actor, id),
      /não comprovada/,
    );
    assert.equal(
      h.sql(
        `select count(*) from sncr_reservations where document_id='${id}';`,
      ),
      '0',
    );
    assert.equal(localSimulationEnabled(), false);
  });
  await test('status público não contém token, session_id, CPF ou ciphertext', async () => {
    const actor = fixture();
    await login(actor);
    const s = JSON.stringify(await sessions.status(actor));
    for (const secret of [
      'synthetic-token-only',
      'token_cipher',
      'session_id',
      '12345678909',
      'CRM 12345',
    ])
      assert.ok(!s.includes(secret));
  });
  await test('receita simples gera PDF sem sessão SNCR; fluxos Bird ID não são alterados', async () => {
    const bytes = await documentPdf(
      {
        kind: 'Receita',
        text: 'Modalidade: simples\n\nMED001',
        patient_name: 'Sintético',
        physician_name: 'Sintético',
        physician_registration: 'CRM 12345 SP',
        document_date: '2026-10-28',
      },
      { isDraft: true },
    );
    assert.ok(bytes.length > 500);
    const core = readFileSync(
      new URL('../lib/signature/document-signing-service.ts', import.meta.url),
      'utf8',
    );
    assert.ok(!core.includes('SncrSessions'));
  });
  await test('RLS e privilégios negam leitura de tokens e chamadas diretas do frontend', () => {
    for (const role of ['anon', 'authenticated', 'service_role'])
      assert.throws(() => h.sql('select * from sncr_user_sessions;', role));
    for (const role of ['anon', 'authenticated'])
      assert.throws(() =>
        h.sql(
          `select sncr_auth_operation('${randomUUID()}','${randomUUID()}','hmg','status');`,
          role,
        ),
      );
  });
  await test('duas conclusões concorrentes fazem uma única troca externa', async () => {
    const actor = fixture(),
      s = await sessions.start(actor, config),
      t = envelope(s),
      before = calls.length;
    const r = await Promise.allSettled([
      sessions.complete(actor, s.binding, t, config),
      sessions.complete(actor, s.binding, t, config),
    ]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(calls.length, before + 1);
  });
  await test('logout durante troca impede resposta tardia de reconectar usuário', async () => {
    const actor = fixture(),
      s = await sessions.start(actor, config);
    let resolve;
    const waiting = new SncrSessions(
      h.db,
      async () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const finishing = waiting.complete(actor, s.binding, envelope(s), config);
    while (!resolve) await new Promise((r) => setTimeout(r, 5));
    await sessions.disconnect(actor);
    resolve(
      Response.json({
        access_token: 'synthetic-late-token',
        token_type: 'Bearer',
      }),
    );
    await assert.rejects(() => finishing);
    assert.equal((await sessions.status(actor)).state, 'disconnected');
  });
  await test('criptografia exige chave explícita e rejeita corrupção do ciphertext', () => {
    const encrypted = sealSession('synthetic', 'test');
    assert.throws(() => openSession(encrypted.slice(0, -2) + 'ff', 'test'));
    const key = process.env.SNCR_SESSION_ENCRYPTION_KEY;
    delete process.env.SNCR_SESSION_ENCRYPTION_KEY;
    try {
      assert.throws(() => sealSession('synthetic', 'test'), /não configurada/);
    } finally {
      process.env.SNCR_SESSION_ENCRYPTION_KEY = key;
    }
  });
  await test('callback remove parâmetros em redirect limpo, usa cookies HttpOnly e não troca token em GET', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      client = new URL(start.authorizationUrl).searchParams.get('client_url'),
      state = new URL(client).pathname.split('/').at(-1),
      before = calls.length;
    const r = route('../app/api/sncr/auth/callback/[state]/route.ts', {
      sncrAuthConfig,
      AUTH_COOKIE: 'psywrite_sncr_binding',
      TRANSFER_COOKIE: 'psywrite_sncr_callback',
      authCookie,
      cookieValue,
      captureSncrCallback,
    });
    const result = await r.GET(
      new Request(client + '?session_id=synthetic-secret-id', {
        headers: { Cookie: `psywrite_sncr_binding=${start.binding}` },
      }),
      { params: Promise.resolve({ state }) },
    );
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('location'), '/sncr/connect');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    assert.ok(
      !result.headers.get('set-cookie').includes('synthetic-secret-id'),
    );
    assert.equal(calls.length, before);
  });
  await test('rotas usam contexto autenticado e recusam CSRF, URL injetada e usuário não médico', async () => {
    const actor = fixture();
    let ctx = { clinic: actor.clinicId, user: actor.userId, role: 'doctor' };
    const handle = (fn) => async (request) => {
      try {
        return await fn(request, ctx);
      } catch (e) {
        return json({ error: e.message }, e.status || 500);
      }
    };
    class ContractSessions extends SncrSessions {
      constructor(db) {
        super(db, transport);
      }
    }
    const api = route('../app/api/sncr/auth/route.ts', {
      handle,
      json,
      writeGuard,
      HttpError,
      adminClient: () => h.db,
      SncrSessions: ContractSessions,
      sncrAuthConfig,
      AUTH_COOKIE,
      TRANSFER_COOKIE,
      authCookie,
    });
    const req = (headers = {}) =>
      new Request(config.origin + '/api/sncr/auth', {
        method: 'POST',
        headers: { 'X-SNCR-Action': '1', Origin: config.origin, ...headers },
        body: JSON.stringify({
          userId: randomUUID(),
          callback: 'https://attacker.com',
          cpf: '00000000000',
        }),
      });
    assert.equal(
      (await api.POST(req({ Origin: 'https://attacker.com' }))).status,
      403,
    );
    ctx = { ...ctx, role: 'secretary' };
    assert.equal((await api.POST(req())).status, 403);
    ctx = { ...ctx, role: 'doctor' };
    const result = await api.POST(req()),
      data = await result.json();
    assert.equal(result.status, 200);
    assert.ok(
      new URL(data.authorizationUrl).searchParams
        .get('client_url')
        .startsWith(config.callback + '/'),
    );
    assert.equal(
      h.sql(
        `select user_id from sncr_login_attempts where clinic_id='${actor.clinicId}';`,
      ),
      actor.userId,
    );
    assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  });
  await test('rota de conclusão devolve somente estado seguro e não repete automaticamente erro 401 externo', async () => {
    const actor = fixture();
    class ContractSessions extends SncrSessions {
      constructor(db) {
        super(db, transport);
      }
    }
    const api = route('../app/api/sncr/auth/complete/route.ts', {
      context: async () => ({
        clinic: actor.clinicId,
        user: actor.userId,
        role: 'doctor',
      }),
      json,
      writeGuard,
      HttpError,
      adminClient: () => h.db,
      SncrSessions: ContractSessions,
      sncrAuthConfig,
      AUTH_COOKIE,
      TRANSFER_COOKIE,
      authCookie,
      cookieValue,
    });
    async function complete() {
      const start = await sessions.start(actor, config),
        transfer = envelope(start);
      return api.POST(
        new Request(config.origin + '/api/sncr/auth/complete', {
          method: 'POST',
          headers: {
            Origin: config.origin,
            'X-SNCR-Action': '1',
            Cookie: `${AUTH_COOKIE}=${start.binding}; ${TRANSFER_COOKIE}=${transfer}`,
          },
        }),
      );
    }
    const success = await complete(),
      body = await success.text();
    assert.equal(success.status, 200);
    assert.ok(body.includes('unverified'));
    assert.ok(!body.includes('synthetic-token-only'));
    assert.match(success.headers.get('set-cookie'), /Max-Age=0/);
    response = () => new Response(null, { status: 401 });
    try {
      const result = await complete();
      assert.equal(result.status, 409);
      assert.match(await result.text(), /novamente/);
    } finally {
      response = () =>
        Response.json({
          access_token: 'synthetic-token-only',
          token_type: 'Bearer',
        });
    }
  });
  await test('envelope de callback vencido é rejeitado antes de trocar session_id', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      state = new URL(
        new URL(start.authorizationUrl).searchParams.get('client_url'),
      ).pathname
        .split('/')
        .at(-1),
      before = calls.length;
    const transfer = sealSession(
      JSON.stringify({
        state,
        sessionId: randomSecret(),
        createdAt: Date.now() - 31000,
        cancelled: false,
      }),
      `callback:${config.origin}:${secretHash(start.binding)}`,
    );
    await assert.rejects(
      () => sessions.complete(actor, start.binding, transfer, config),
      /expirado/,
    );
    assert.equal(calls.length, before);
  });
  await test('resposta do banco perdida após COMMIT não permite segunda troca externa', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      transfer = envelope(start);
    let lost = true;
    const db = {
      rpc: async (name, args) => {
        const result = await h.db.rpc(name, args);
        if (args.p_action === 'complete' && lost) {
          lost = false;
          throw Error('simulated lost response after actual commit');
        }
        return result;
      },
    };
    const service = new SncrSessions(db, transport);
    await assert.rejects(() =>
      service.complete(actor, start.binding, transfer, config),
    );
    const before = calls.length;
    assert.equal((await sessions.status(actor)).state, 'connected');
    await assert.rejects(() =>
      sessions.complete(actor, start.binding, transfer, config),
    );
    assert.equal(calls.length, before);
  });
  await test('resposta inválida ou indisponibilidade externa é sanitizada, sem retry', async () => {
    for (const mock of [
      () => new Response('SENSITIVE', { status: 503 }),
      () => Response.json({ access_token: 'token', token_type: 'Other' }),
      () => new Response('x'.repeat(33000)),
    ]) {
      let count = 0;
      await assert.rejects(
        () =>
          exchangeSncrSession(config, 'synthetic', async () => {
            count++;
            return mock();
          }),
        (e) => !e.message.includes('SENSITIVE'),
      );
      assert.equal(count, 1);
    }
  });
  await test('falha do banco antes da reserva da tentativa não inicia troca externa', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config),
      before = calls.length;
    const offline = new SncrSessions(
      {
        rpc: async () => {
          throw Error('simulated database offline');
        },
      },
      transport,
    );
    await assert.rejects(
      () => offline.complete(actor, start.binding, envelope(start), config),
      /Banco/,
    );
    assert.equal(calls.length, before);
  });
  await test('reinicialização real do banco preserva sessão cifrada e vínculo', async () => {
    const actor = fixture();
    await login(actor);
    execFileSync(containerEngine, ['restart', h.container], {
      stdio: 'pipe',
      timeout: 15000,
    });
    for (let i = 0; i < 30; i++) {
      try {
        execFileSync(
          containerEngine,
          ['exec', h.container, 'pg_isready', '-U', 'postgres'],
          { stdio: 'pipe' },
        );
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.equal((await sessions.status(actor)).state, 'connected');
    const data = await authOperation(h.db, actor, 'hmg', 'read');
    assert.equal(
      openSession(
        data.token_cipher,
        `${actor.clinicId}:${actor.userId}:hmg:${data.id}`,
      ),
      'synthetic-token-only',
    );
  });
  await test('logging Next ignora somente callbacks sensíveis', async () => {
    const { default: nextConfig } = await import('../next.config.ts');
    assert.ok(
      nextConfig.logging.incomingRequests.ignore.some((p) =>
        p.test('/api/sncr/auth/callback/opaque?session_id=synthetic'),
      ),
    );
    assert.ok(
      !nextConfig.logging.incomingRequests.ignore.some((p) =>
        p.test('/api/documents'),
      ),
    );
  });
  await test('processo interrompido durante troca conserva estado incerto após expiração', async () => {
    const actor = fixture(),
      start = await sessions.start(actor, config);
    const state = new URL(
      new URL(start.authorizationUrl).searchParams.get('client_url'),
    ).pathname
      .split('/')
      .at(-1);
    await authOperation(h.db, actor, 'hmg', 'claim', {
      state_hash: secretHash(state),
      binding_hash: secretHash(start.binding),
      session_hash: secretHash(randomSecret()),
    });
    h.sql(
      `update sncr_login_attempts set expires_at=now()-interval '1s' where user_id='${actor.userId}';`,
    );
    assert.equal((await sessions.status(actor)).state, 'uncertain');
    const before = calls.length;
    await assert.rejects(() =>
      sessions.complete(actor, start.binding, envelope(start), config),
    );
    assert.equal(calls.length, before);
  });
  await test('migração original mantém proteção e histórico não contém segredos', () => {
    assert.ok(
      readFileSync(
        new URL(
          '../supabase/migrations/20261027010000_sncr_numbering.sql',
          import.meta.url,
        ),
        'utf8',
      ).includes("raise exception 'Migração SNCR em revisão: não aplicar'"),
    );
    assert.equal(migration.split(guard).length, 2);
    assert.ok(
      !h
        .sql(
          "select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb) from sncr_session_events e;",
        )
        .includes('synthetic-token-only'),
    );
  });
} finally {
  h.cleanup();
  for (const k of keys) {
    if (old[k] === undefined) delete process.env[k];
    else process.env[k] = old[k];
  }
}
