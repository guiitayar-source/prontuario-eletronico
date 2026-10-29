// PostgreSQL e PostgREST reais; Auth/PSC exclusivamente sintéticos. Sem rede externa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import {
  createSignatureTrustDb,
  oauthMigration,
  oauthGuard as migrationGuard,
} from './helpers/signature-trust-db.mjs';
import { startSignatureTrustRest } from './helpers/signature-trust-rest.mjs';
import { containerEngine } from './helpers/sncr-container.mjs';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { decryptToken, encryptToken } from '../lib/signature/crypto-utils.ts';
const root = new URL('../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { DocumentSigningService } =
  await import('../lib/signature/document-signing-service.ts');
const { setCustomSignatureProvider } =
  await import('../lib/signature/provider-factory.ts');
const oauth = await import('../lib/signature/oauth-context.ts');
const { HttpError } = await import('../lib/supabase/server.ts');
const { PscProvider } = await import('../lib/signature/psc-provider.ts');
const authorizationProvider = new PscProvider({
  label: 'PSC sintético',
  baseUrl: 'https://psc.synthetic/v0',
  clientId: 'synthetic',
  clientSecret: 'synthetic',
});
const authorize =
  await import('../app/api/digital-signature/birdid/authorize/route.ts');
const callback =
  await import('../app/api/digital-signature/birdid/callback/route.ts');
const completeRoute =
  await import('../app/api/digital-signature/birdid/complete/route.ts');
const provider = new MockBirdIdProvider({ mockCpf: '52998224725' });
const otherProvider = new MockBirdIdProvider({ mockCpf: '11144477735' });
const cpf = '52998224725',
  otherCpf = '11144477735',
  base = 'https://psywrite.synthetic';
const redirectUri = base + '/api/digital-signature/birdid/callback';
const envKeys = [
  'NODE_ENV',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SIGNATURE_ENCRYPTION_KEY',
  'BIRDID_REDIRECT_URI',
  'VIDAAS_REDIRECT_URI',
];
const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const oldFetch = globalThis.fetch;
const h = createSignatureTrustDb({ oauth: true });
const exchanges = [];
let rest,
  discovery = provider,
  exchange = async () => ({
    accessToken: 'SYNTHETIC_TOKEN_SECRET',
    expiresIn: 3600,
    tokenType: 'Bearer',
    cpf: otherCpf,
  });
try {
  rest = await startSignatureTrustRest(h);
  const serverToken = rest.jwt('service_role');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: rest.jwt('anon'),
    SUPABASE_SECRET_KEY: serverToken,
    SIGNATURE_ENCRYPTION_KEY: 'synthetic-6d-only',
    BIRDID_REDIRECT_URI: redirectUri,
    VIDAAS_REDIRECT_URI: redirectUri,
  });
  const validTokens = new Map();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    assert.equal(
      url.origin,
      'http://127.0.0.1:54321',
      'Rede não local bloqueada.',
    );
    if (url.pathname.startsWith('/rest/v1/'))
      return rest.fetch(
        new Request(
          'http://signature.synthetic' + url.pathname + url.search,
          request,
        ),
      );
    if (url.pathname === '/auth/v1/user') {
      const actor = validTokens.get(
        request.headers.get('authorization')?.replace(/^Bearer /, ''),
      );
      return Response.json(
        actor
          ? { id: actor.userId, aud: 'authenticated' }
          : { message: 'Invalid' },
        { status: actor ? 200 : 401 },
      );
    }
    throw Error('Transporte não previsto.');
  };
  const backend = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    serverToken,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const service = new DocumentSigningService(() => backend);
  setCustomSignatureProvider({
    getAuthorizationUrl: (p) => authorizationProvider.getAuthorizationUrl(p),
    async exchangeAuthorizationCode(p) {
      exchanges.push(p);
      return exchange(p);
    },
    getCertificates: (token) =>
      typeof discovery === 'function'
        ? discovery(token)
        : discovery.getCertificates(token),
  });
  function actor() {
    const a = {
      clinicId: randomUUID(),
      userId: randomUUID(),
      authSessionId: randomUUID(),
    };
    h.sql(
      `insert into auth.users values('${a.userId}'); insert into auth.sessions values('${a.authSessionId}','${a.userId}',null); insert into clinics(id,name) values('${a.clinicId}','Sintética'); insert into clinic_members(clinic_id,user_id,role) values('${a.clinicId}','${a.userId}','doctor'); insert into document_profiles(clinic_id,user_id,physician_name,physician_registration,cpf) values('${a.clinicId}','${a.userId}','Sintético','CRM 123 SP','${cpf}');`,
    );
    a.token = rest.jwt('authenticated', a.userId, {
      session_id: a.authSessionId,
    });
    validTokens.set(a.token, a);
    return a;
  }
  async function start(a = actor(), providerId = 'birdid') {
    const binding = oauth.oauthSecret();
    const s = await service.initiateOAuthSession({
      db: backend,
      ...a,
      binding,
      provider: providerId,
    });
    return { ...a, ...s, binding, redirectUri, code: 'SYNTHETIC_CODE_SECRET' };
  }
  const finish = (s, override = {}) =>
    service.handleOAuthCallback({ db: backend, ...s, ...override });
  const row = (s) =>
    JSON.parse(
      h.sql(
        `select to_jsonb(a) from signature_oauth_states a where state_hash=${h.lit(oauth.oauthHash('state', s.state))};`,
      ),
    );
  const sessions = (a) =>
    JSON.parse(
      h.sql(
        `select coalesce(jsonb_agg(to_jsonb(s)),'[]') from signature_sessions s where user_id='${a.userId}';`,
      ),
    );
  const noExchange = async (fn) => {
    const before = exchanges.length;
    await assert.rejects(fn);
    assert.equal(exchanges.length, before);
  };
  function cookies(s, transfer) {
    return (
      oauth.oauthCookieName(
        oauth.oauthHash('state', s.state),
        'binding',
        base,
      ) +
      '=' +
      s.binding +
      (transfer
        ? '; ' +
          oauth.oauthCookieName(
            oauth.oauthHash('state', s.state),
            'transfer',
            base,
          ) +
          '=' +
          transfer
        : '')
    );
  }
  function envelope(s, query = '?code=SYNTHETIC_CODE_SECRET') {
    return oauth.captureOAuthCallback(
      new Request(redirectUri + query + '&state=' + s.state, {
        headers: { Cookie: cookies(s) },
      }),
    );
  }
  const post = (a, path, body, cookie = '', headers = {}) =>
    new Request(base + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + a.token,
        Origin: base,
        'X-Signature-Action': '1',
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  await test('mesmo usuário/navegador/sessão: PKCE S256, TTL 5min, token cifrado e identidade X509', async () => {
    const s = await start(),
      auth = new URL(s.authorizationUrl),
      before = Date.now();
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(row(s).status, 'pending');
    assert.ok(new Date(row(s).expires_at) - before <= 300000);
    const result = await finish(s),
      stored = sessions(s)[0];
    assert.equal(result.userId, s.userId);
    assert.equal(result.cpf, cpf);
    assert.equal(row(s).status, 'completed');
    assert.equal(row(s).code_verifier_encrypted, '');
    assert.equal(
      decryptToken(stored.access_token_encrypted),
      'SYNTHETIC_TOKEN_SECRET',
    );
    assert.equal(
      stored.certificate_raw,
      (await provider.getCertificates('synthetic'))[0].rawPem,
    );
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_TOKEN_SECRET'));
    assert.notEqual(
      exchanges.at(-1).codeVerifier,
      row(s).code_verifier_encrypted,
    );
  });
  await test('médico A inicia e médico B apresenta callback: recusa antes de HTTP', async () => {
    const s = await start(),
      b = actor();
    await noExchange(() => finish(s, b));
    assert.equal(row(s).status, 'pending');
    assert.equal(sessions(b).length, 0);
  });
  await test('outro navegador, cookie ausente ou trocado: nenhuma troca externa', async () => {
    const s = await start();
    for (const binding of ['', oauth.oauthSecret()])
      await noExchange(() => finish(s, { binding }));
    assert.throws(() =>
      oauth.captureOAuthCallback(
        new Request(redirectUri + '?state=' + s.state + '&code=secret'),
      ),
    );
  });
  await test('mesmo usuário em outra sessão Supabase não pode concluir', async () => {
    const s = await start(),
      sid = randomUUID();
    h.sql(`insert into auth.sessions values('${sid}','${s.userId}',null);`);
    await noExchange(() => finish(s, { authSessionId: sid }));
    await noExchange(() => finish(s, { authSessionId: '' }));
  });
  await test('sessão revogada ou expirada recusa callback', async () => {
    for (const expired of [false, true]) {
      const s = await start();
      h.sql(
        expired
          ? `update auth.sessions set not_after=now()-interval '1s' where id='${s.authSessionId}';`
          : `delete from auth.sessions where id='${s.authSessionId}';`,
      );
      await noExchange(() => finish(s));
      assert.equal(row(s).status, 'rejected');
    }
  });
  await test('state inválido e SNCR não são aceitos no namespace Bird ID', async () => {
    const s = await start();
    for (const state of ['bad', oauth.oauthSecret()])
      await noExchange(() => finish(s, { state }));
    const { SncrSessions } = await import('../lib/sncr/sessions.ts');
    const previousKey = process.env.SNCR_SESSION_ENCRYPTION_KEY;
    process.env.SNCR_SESSION_ENCRYPTION_KEY = 'a'.repeat(64);
    try {
      const sncr = new SncrSessions(backend, async () => {
        throw Error('Rede SNCR proibida.');
      });
      const started = await sncr.start(s, {
        environment: 'hmg',
        callback: 'http://localhost:3000/api/sncr/auth/callback',
        origin: 'http://localhost:3000',
      });
      const sncrState = new URL(started.authorizationUrl).searchParams.get(
        'state',
      );
      await noExchange(() =>
        finish(s, { state: sncrState, binding: started.binding }),
      );
      assert.equal((await sncr.status(s)).state, 'pending');
      assert.equal(row(s).status, 'pending');
    } finally {
      if (previousKey === undefined)
        delete process.env.SNCR_SESSION_ENCRYPTION_KEY;
      else process.env.SNCR_SESSION_ENCRYPTION_KEY = previousKey;
    }
  });
  await test('state expirado vira expired sem HTTP', async () => {
    const s = await start();
    h.sql(
      `update signature_oauth_states set expires_at=now()-interval '1s' where id='${row(s).id}';`,
    );
    await noExchange(() => finish(s));
    assert.equal(row(s).status, 'expired');
  });
  await test('callback repetido não pode trocar novamente', async () => {
    const s = await start();
    await finish(s);
    await noExchange(() => finish(s));
    assert.equal(sessions(s).length, 1);
  });
  await test('dois callbacks simultâneos: exatamente uma troca e uma sessão', async () => {
    const s = await start(),
      before = exchanges.length;
    const results = await Promise.allSettled([finish(s), finish(s)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(exchanges.length, before + 1);
    assert.equal(sessions(s).length, 1);
    assert.equal(row(s).status, 'completed');
  });
  function sqlAsync(statement) {
    return new Promise((resolve, reject) => {
      const child = spawn(containerEngine, [
        'exec',
        '-i',
        h.container,
        'psql',
        '-X',
        '-U',
        'supabase_admin',
        '-d',
        h.database,
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
      ]);
      let out = '',
        err = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (err += b));
      child.on('error', reject);
      child.on('close', (c) => (c ? reject(Error(err)) : resolve(out.trim())));
      child.stdin.end(statement);
    });
  }
  await test('aquisição é atômica em duas conexões PostgreSQL realmente concorrentes', async () => {
    const s = await start();
    const query = `begin; set role service_role; select pg_sleep(0.1); select signature_oauth_operation('claim','${s.clinicId}','${s.userId}','${s.authSessionId}','${oauth.oauthHash('state', s.state)}','${oauth.oauthHash('browser', s.binding)}',${h.lit({ redirect_uri: redirectUri })}); commit;`;
    const results = (await Promise.all([sqlAsync(query), sqlAsync(query)])).map(
      (x) => JSON.parse(x.trim()),
    );
    assert.equal(
      results.filter((r) => r.status === 'processing' && r.verifier).length,
      1,
    );
    assert.equal(results.filter((r) => r.status === 'unavailable').length, 1);
  });
  for (const [name, failure, status] of [
    [
      'código inválido',
      () => {
        throw new HttpError(400, 'SYNTHETIC_CODE_SECRET');
      },
      'rejected',
    ],
    [
      'falha HTTP externa',
      () => {
        throw new HttpError(503, 'SYNTHETIC_TOKEN_SECRET');
      },
      'uncertain',
    ],
    [
      'timeout externo',
      () => {
        throw new DOMException('SYNTHETIC_CODE_SECRET', 'TimeoutError');
      },
      'uncertain',
    ],
  ])
    await test(
      name + ': consumo durável, mensagem sanitizada e nenhuma repetição',
      async () => {
        const old = exchange,
          s = await start(),
          before = exchanges.length;
        exchange = failure;
        try {
          await assert.rejects(
            () => finish(s),
            (e) => !e.message.includes('SECRET'),
          );
          assert.equal(row(s).status, status);
          await noExchange(() => finish(s));
          assert.equal(exchanges.length, before + 1);
        } finally {
          exchange = old;
        }
      },
    );
  await test('erro local após claim e antes de HTTP não libera state', async () => {
    const s = await start();
    h.sql(
      `update signature_oauth_states set code_verifier_encrypted='invalid' where id='${row(s).id}';`,
    );
    await noExchange(() => finish(s));
    assert.equal(row(s).status, 'rejected');
    await noExchange(() => finish(s));
  });
  await test('perda da resposta do claim após COMMIT não repete nem inicia troca', async () => {
    const s = await start();
    const lossy = new DocumentSigningService(() => ({
      rpc: async (n, args) => {
        await backend.rpc(n, args);
        throw Error('synthetic lost commit response');
      },
    }));
    await noExchange(() => lossy.handleOAuthCallback({ db: backend, ...s }));
    assert.equal(row(s).status, 'processing');
    await noExchange(() => finish(s));
    h.sql(
      `update signature_oauth_states set expires_at=now()-interval '1s' where id='${row(s).id}';`,
    );
    await noExchange(() => finish(s));
    assert.equal(row(s).status, 'uncertain');
  });
  await test('resposta perdida do COMMIT final conserva sessão única sem repetir troca', async () => {
    const s = await start();
    let lost = true;
    const lossy = new DocumentSigningService(() => ({
      from: backend.from.bind(backend),
      rpc: async (name, args) => {
        const result = await backend.rpc(name, args);
        if (args.p_action === 'finish' && lost) {
          lost = false;
          throw Error('Resposta final perdida após COMMIT.');
        }
        return result;
      },
    }));
    const before = exchanges.length;
    await assert.rejects(() =>
      lossy.handleOAuthCallback({ db: backend, ...s }),
    );
    assert.equal(row(s).status, 'completed');
    assert.equal(sessions(s).length, 1);
    await noExchange(() => finish(s));
    assert.equal(exchanges.length, before + 1);
  });
  await test('duas tentativas legítimas independentes do mesmo usuário', async () => {
    const a = actor(),
      s1 = await start(a),
      s2 = await start(a),
      before = exchanges.length;
    assert.notEqual(s1.binding, s2.binding);
    assert.notEqual(s1.state, s2.state);
    await Promise.all([finish(s1), finish(s2)]);
    assert.equal(exchanges.length, before + 2);
    assert.equal(sessions(a).filter((s) => !s.revoked).length, 1);
    assert.equal(row(s1).status, 'completed');
    assert.equal(row(s2).status, 'completed');
  });
  await test('conclusões concorrentes com titulares diferentes não sobrescrevem identidade inicial', async () => {
    const a = actor();
    h.sql(`update document_profiles set cpf=null where user_id='${a.userId}';`);
    const s1 = await start(a),
      s2 = await start(a),
      oldExchange = exchange;
    exchange = async (p) => ({ accessToken: p.code, expiresIn: 3600 });
    discovery = (token) =>
      (token === 'first' ? provider : otherProvider).getCertificates(
        'synthetic',
      );
    try {
      const results = await Promise.allSettled([
        finish(s1, { code: 'first' }),
        finish(s2, { code: 'second' }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(sessions(a).length, 1);
      assert.equal(sessions(a)[0].revoked, true);
      assert.equal(
        [row(s1).status, row(s2).status]
          .sort((a, b) => a.localeCompare(b))
          .join(','),
        'completed,rejected',
      );
    } finally {
      exchange = oldExchange;
      discovery = provider;
    }
  });
  await test('dois médicos simultâneos conservam sessões isoladas', async () => {
    const s1 = await start(),
      s2 = await start();
    const [r1, r2] = await Promise.all([finish(s1), finish(s2)]);
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.userId, s1.userId);
    assert.equal(r2.userId, s2.userId);
  });
  await test('VIDaaS conserva o mesmo vínculo e isolamento', async () => {
    const s = await start(actor(), 'vidaas');
    assert.equal((await finish(s)).provider, 'vidaas');
  });
  await test('CPF/certificado incompatível não cria sessão ou altera perfil', async () => {
    const s = await start();
    discovery = otherProvider;
    try {
      await assert.rejects(() => finish(s));
      assert.equal(sessions(s).length, 0);
      assert.equal(row(s).status, 'rejected');
      assert.equal(
        h.sql(`select cpf from document_profiles where user_id='${s.userId}';`),
        cpf,
      );
    } finally {
      discovery = provider;
    }
  });
  await test('perfil editado não sobrescreve silenciosamente identidade de certificado anterior', async () => {
    const a = actor(),
      s1 = await start(a);
    await finish(s1);
    h.sql(
      `update document_profiles set cpf='${otherCpf}' where user_id='${a.userId}';`,
    );
    const s2 = await start(a);
    discovery = otherProvider;
    try {
      await assert.rejects(() => finish(s2));
      assert.equal(sessions(a).length, 1);
      assert.equal(sessions(a)[0].revoked, true);
      assert.equal(row(s2).status, 'rejected');
    } finally {
      discovery = provider;
    }
  });
  await test('certificado antigo incompatível também bloqueia quando CPF persistido foi adulterado', async () => {
    const s = await start(),
      cert = (await otherProvider.getCertificates('synthetic'))[0];
    h.sql(
      `insert into signature_sessions(clinic_id,user_id,provider,cpf,certificate_alias,certificate_subject,certificate_issuer,certificate_valid_from,certificate_valid_to,certificate_raw,access_token_encrypted,expires_at) values('${s.clinicId}','${s.userId}','birdid','${cpf}','old','old','old',now()-interval '1 day',now()+interval '1 day',${h.lit(cert.rawPem)},'cipher',now()+interval '1 day');`,
    );
    await assert.rejects(() => finish(s));
    assert.equal(sessions(s)[0].revoked, true);
    assert.equal(sessions(s).length, 1);
  });
  await test('sessão legada sem certificado exige nova autorização e é revogada', async () => {
    const s = await start();
    h.sql(
      `insert into signature_sessions(clinic_id,user_id,provider,cpf,certificate_alias,certificate_subject,certificate_issuer,certificate_valid_from,certificate_valid_to,access_token_encrypted,expires_at) values('${s.clinicId}','${s.userId}','birdid','${cpf}','legacy','legacy','legacy',now()-interval '1 day',now()+interval '1 day','cipher',now()+interval '1 day');`,
    );
    await finish(s);
    assert.equal(sessions(s).length, 2);
    assert.equal(sessions(s).filter((r) => !r.revoked).length, 1);
    assert.ok(sessions(s).find((r) => !r.revoked).certificate_raw);
  });
  await test('logout durante troca externa impede resposta tardia de criar sessão', async () => {
    const s = await start(),
      old = exchange;
    let release;
    exchange = () => new Promise((r) => (release = r));
    const finishing = finish(s);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    h.sql(`delete from auth.sessions where id='${s.authSessionId}';`);
    release({ accessToken: 'SYNTHETIC_TOKEN_SECRET', expiresIn: 3600 });
    try {
      await assert.rejects(() => finishing);
      assert.equal(sessions(s).length, 0);
      assert.equal(row(s).status, 'rejected');
    } finally {
      exchange = old;
    }
  });
  await test('cancelamento do provedor consome tentativa sem HTTP ou reflexão de descrição', async () => {
    const s = await start(),
      e = envelope(
        s,
        '?error=access_denied&error_description=SYNTHETIC_TOKEN_SECRET',
      ),
      opened = oauth.openOAuthCallback(e.attempt, s.binding, e.transfer);
    await noExchange(() => finish(s, opened));
    assert.equal(row(s).status, 'rejected');
    assert.ok(!e.transfer.includes('SYNTHETIC_TOKEN_SECRET'));
  });
  await test('GET remove segredos da URL e guarda envelope cifrado em cookie HttpOnly Secure Lax', async () => {
    const s = await start(),
      before = exchanges.length;
    const result = await callback.GET(
      new Request(
        redirectUri +
          '?state=' +
          s.state +
          '&code=SYNTHETIC_CODE_SECRET&next=https://evil.example',
        { headers: { Cookie: cookies(s) } },
      ),
    );
    assert.equal(result.status, 303);
    assert.match(
      result.headers.get('location'),
      /^\/signature\/connect\?attempt=[a-f0-9]{64}$/,
    );
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
    assert.match(
      result.headers.get('set-cookie'),
      /__Host-.*HttpOnly; SameSite=Lax; Max-Age=60; Secure/,
    );
    assert.ok(
      !result.headers.get('set-cookie').includes('SYNTHETIC_CODE_SECRET'),
    );
    assert.equal(exchanges.length, before);
    for (const query of [
      '?error_description=SYNTHETIC_TOKEN_SECRET',
      '?state=bad&code=secret',
    ]) {
      const r = await callback.GET(new Request(redirectUri + query));
      assert.equal(
        r.headers.get('location'),
        '/signature/connect?result=invalid',
      );
    }
  });
  await test('POST completo usa o Bearer validado, ignora identidade e redirecionamento forjados no corpo', async () => {
    const s = await start(),
      e = envelope(s);
    const r = await completeRoute.POST(
      post(
        s,
        '/api/digital-signature/birdid/complete',
        {
          attempt: e.attempt,
          userId: randomUUID(),
          redirectUri: 'https://evil.example',
        },
        cookies(s, e.transfer),
      ),
    );
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'connected' });
    assert.equal(sessions(s).length, 1);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  });
  await test('POST sem sessão válida, outro usuário, outra sessão e CSRF não chamam PSC', async () => {
    const s = await start(),
      e = envelope(s),
      b = actor(),
      before = exchanges.length;
    for (const [a, headers] of [
      [{ token: 'invalid' }, {}],
      [b, {}],
      [s, { Origin: 'https://evil.example' }],
      [s, { 'X-Signature-Action': '' }],
    ]) {
      const r = await completeRoute.POST(
        post(
          a,
          '/api/digital-signature/birdid/complete',
          { attempt: e.attempt },
          cookies(s, e.transfer),
          headers,
        ),
      );
      assert.ok(r.status >= 400);
    }
    assert.equal(exchanges.length, before);
    assert.equal(sessions(s).length, 0);
  });
  await test('envelope alterado, expirado ou de outra tentativa não chama PSC', async () => {
    const s = await start(),
      e = envelope(s),
      s2 = await start(s);
    assert.throws(() =>
      oauth.openOAuthCallback(
        e.attempt,
        s.binding,
        e.transfer.slice(0, -2) + '00',
      ),
    );
    assert.throws(() =>
      oauth.openOAuthCallback(
        oauth.oauthHash('state', s2.state),
        s2.binding,
        e.transfer,
      ),
    );
    const expired = encryptToken(
      JSON.stringify({
        purpose: 'psc-callback-v1',
        state: s.state,
        code: 'secret',
        cancelled: false,
        bindingHash: oauth.oauthHash('browser', s.binding),
        createdAt: Date.now() - 61000,
        redirectUri,
      }),
    );
    assert.throws(() => oauth.openOAuthCallback(e.attempt, s.binding, expired));
  });
  await test('cookies isolam duas tentativas no mesmo navegador; duplicatas de cookie são recusadas', async () => {
    const a = actor(),
      s1 = await start(a),
      s2 = await start(a);
    const both = cookies(s1) + '; ' + cookies(s2);
    for (const s of [s1, s2]) {
      const e = oauth.captureOAuthCallback(
        new Request(redirectUri + '?state=' + s.state + '&code=secret', {
          headers: { Cookie: both },
        }),
      );
      assert.equal(
        oauth.openOAuthCallback(e.attempt, s.binding, e.transfer).state,
        s.state,
      );
    }
    assert.throws(() =>
      oauth.captureOAuthCallback(
        new Request(redirectUri + '?state=' + s1.state + '&code=secret', {
          headers: { Cookie: cookies(s1) + '; ' + cookies(s1) },
        }),
      ),
    );
  });
  await test('início é POST autenticado, origem fixa, sem callback arbitrário', async () => {
    const a = actor();
    const r = await authorize.POST(
      post(a, '/api/digital-signature/birdid/authorize?provider=birdid', {
        redirectUri: 'https://evil.example',
      }),
    );
    assert.equal(r.status, 200);
    assert.equal(
      new URL((await r.json()).authorizationUrl).searchParams.get(
        'redirect_uri',
      ),
      redirectUri,
    );
    assert.match(
      r.headers.get('set-cookie'),
      /HttpOnly; SameSite=Lax; Max-Age=300; Secure/,
    );
    for (const headers of [
      { Origin: 'https://evil.example' },
      { Origin: '' },
      { 'X-Signature-Action': '' },
    ])
      assert.equal(
        (
          await authorize.POST(
            post(
              a,
              '/api/digital-signature/birdid/authorize?provider=birdid',
              {},
              '',
              headers,
            ),
          )
        ).status,
        403,
      );
    assert.equal(authorize.GET, undefined);
  });
  await test('URL de retorno inválida, credenciais em URL e query arbitrária são bloqueadas', () => {
    const old = process.env.BIRDID_REDIRECT_URI;
    try {
      for (const url of [
        'https://evil.example/',
        'https://user:pass@psywrite.synthetic/api/digital-signature/birdid/callback',
        redirectUri + '?next=https://evil.example',
        'http://psywrite.synthetic/api/digital-signature/birdid/callback',
        redirectUri + '#secret',
      ]) {
        process.env.BIRDID_REDIRECT_URI = url;
        assert.throws(() => oauth.oauthRedirect('birdid'));
      }
    } finally {
      process.env.BIRDID_REDIRECT_URI = old;
    }
    assert.throws(() =>
      oauth.oauthGuard(
        new Request('https://evil.example/complete', {
          method: 'POST',
          headers: {
            Origin: 'https://evil.example',
            'X-Signature-Action': '1',
          },
        }),
        redirectUri,
      ),
    );
  });
  await test('permissões 6C: frontend não fabrica/consome estados, altera vínculo, token ou RPC', async () => {
    const s = await start();
    for (const role of ['anon', 'authenticated']) {
      for (const query of [
        'select * from signature_oauth_states;',
        `update signature_oauth_states set status='pending',user_id='${s.userId}';`,
        `insert into signature_oauth_states(clinic_id,user_id,state_hash,code_verifier_encrypted,redirect_uri,expires_at) values('${s.clinicId}','${s.userId}','forged','cipher','evil',now());`,
        `update signature_sessions set access_token_encrypted='forged';`,
        `select signature_oauth_operation('claim','${s.clinicId}','${s.userId}','${s.authSessionId}','${oauth.oauthHash('state', s.state)}','${oauth.oauthHash('browser', s.binding)}','{}');`,
      ])
        assert.throws(() => h.sql(query, { role, user: s.userId }));
    }
    for (const query of [
      "update signature_oauth_states set status='pending';",
      'delete from signature_oauth_states;',
    ])
      assert.throws(() => h.sql(query, { role: 'service_role' }));
    assert.equal(
      h.sql(
        "select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid='public.signature_oauth_operation(text,uuid,uuid,uuid,text,text,jsonb)'::regprocedure;",
      ),
      't',
    );
  });
  await test('migração reaplicável conserva tentativas concluídas e bloqueio original', async () => {
    const s = await start();
    await finish(s);
    const source = readFileSync(
      new URL('../supabase/migrations/' + oauthMigration, import.meta.url),
      'utf8',
    );
    const legacyState = oauth.oauthSecret();
    h.sql(
      `insert into signature_oauth_states(clinic_id,user_id,state_hash,code_verifier_encrypted,redirect_uri,expires_at) values('${s.clinicId}','${s.userId}',${h.lit(oauth.oauthHash('state', legacyState))},'legacy',${h.lit(redirectUri)},now()+interval '1 day');`,
    );
    assert.throws(() => h.sql('begin;' + source + 'commit;'));
    h.sql(
      'begin;' +
        source.replace(migrationGuard, '-- somente cópia descartável') +
        'commit;',
    );
    assert.equal(row(s).status, 'completed');
    const legacy = row({ ...s, state: legacyState });
    assert.equal(legacy.status, 'rejected');
    assert.equal(legacy.code_verifier_encrypted, '');
    await noExchange(() => finish(s));
    await noExchange(() => finish(s, { state: legacyState }));
  });
  await test('auditoria e logging Next não expõem código, token, CPF ou URL sensível', async () => {
    const logs = h.sql(
      "select coalesce(jsonb_agg(to_jsonb(a)),'[]') from audit_events a where action like 'signature_oauth_%';",
    );
    for (const secret of [
      'SYNTHETIC_CODE_SECRET',
      'SYNTHETIC_TOKEN_SECRET',
      cpf,
      otherCpf,
    ])
      assert.ok(!logs.includes(secret));
    const { default: config } = await import('../next.config.ts');
    for (const path of [
      '/api/digital-signature/birdid/callback?code=secret',
      '/api/digital-signature/vidaas/callback?code=secret',
      '/api/sncr/auth/callback/opaque?session_id=secret',
    ])
      assert.ok(
        config.logging.incomingRequests.ignore.some((p) => p.test(path)),
      );
    assert.ok(
      !config.logging.incomingRequests.ignore.some((p) =>
        p.test('/api/documents'),
      ),
    );
  });
} finally {
  globalThis.fetch = oldFetch;
  setCustomSignatureProvider(null);
  rest?.cleanup();
  h.cleanup();
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}
