import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { register } from 'node:module';
import ts from 'typescript';
const root = new URL('../', import.meta.url).href;
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))return next(new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href,c);return next(s,c);}`,
    ),
  import.meta.url,
);
const { PscProvider } = await import('../lib/signature/psc-provider.ts');
const oauth = await import('../lib/signature/oauth-context.ts');
const psc = new PscProvider({
  label: 'PSC sintético',
  baseUrl: 'https://psc.synthetic/v0',
  clientId: 'synthetic',
  clientSecret: 'synthetic',
});
const original = globalThis.fetch;
after(() => (globalThis.fetch = original));
for (const status of [400, 401, 403, 500, 503])
  test(`token exchange HTTP ${status}: não reflete corpo sensível, não segue redirect, não repete`, async () => {
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      return new Response('CODE_SECRET TOKEN_SECRET', { status });
    };
    await assert.rejects(
      () =>
        psc.exchangeAuthorizationCode({
          code: 'CODE_SECRET',
          codeVerifier: 'synthetic',
          redirectUri:
            'https://psywrite.synthetic/api/digital-signature/birdid/callback',
        }),
      (e) => e.status === status && !e.message.includes('SECRET'),
    );
    assert.equal(calls, 1);
  });
test('descoberta não reflete resposta sensível e não segue redirect', async () => {
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('TOKEN_SECRET', { status: 503 });
  };
  await assert.rejects(
    () => psc.getCertificates('TOKEN_SECRET'),
    (e) => !e.message.includes('SECRET'),
  );
});
test('token inválido ou resposta malformada nunca recebe fallback de sucesso', async () => {
  for (const payload of [
    {},
    { access_token: 'token', token_type: 'Other' },
    { access_token: 'token', expires_in: -1 },
    { access_token: 'token', expires_in: 999999 },
  ]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(() =>
      psc.exchangeAuthorizationCode({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'https://psywrite.synthetic/callback',
      }),
    );
  }
});
test('cookies HTTPS são __Host/Secure sem Domain e loopback local usa HttpOnly/Lax', () => {
  const id = 'a'.repeat(64);
  assert.match(
    oauth.oauthCookie(
      id,
      'binding',
      'secret',
      'https://psywrite.synthetic',
      300,
    ),
    /^__Host-.*Path=\/; HttpOnly; SameSite=Lax; Max-Age=300; Secure$/,
  );
  const local = oauth.oauthCookie(
    id,
    'binding',
    'secret',
    'http://localhost:3000',
    300,
  );
  assert.ok(!local.includes('Secure'));
  assert.ok(!local.includes('Domain='));
  assert.match(local, /HttpOnly; SameSite=Lax/);
});
test('abas simultâneas: resultado de uma tentativa não fecha outra', async () => {
  const source = readFileSync(
    new URL('../lib/signature/signature-tab.ts', import.meta.url),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'signature-tab.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const noImports = ts.factory.updateSourceFile(
    ast,
    ast.statements.filter((s) => !ts.isImportDeclaration(s)),
  );
  const code = ts.transpileModule(ts.createPrinter().printFile(noImports), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const channels = [],
    exports = {};
  class Channel {
    constructor() {
      channels.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  runInNewContext(code, {
    exports,
    URL,
    crypto: globalThis.crypto,
    TextEncoder,
    Uint8Array,
    BroadcastChannel: Channel,
    setInterval: () => 1,
    clearInterval: () => {},
    useEffect: () => {},
    useRef: () => ({}),
  });
  const state1 = oauth.oauthSecret(),
    state2 = oauth.oauthSecret();
  const tab = () => ({
      location: {},
      closed: false,
      close() {
        this.closed = true;
      },
    }),
    a = tab(),
    b = tab();
  exports.sendTabToProvider(
    a,
    'https://psc.synthetic/authorize?state=' + state1,
  );
  exports.sendTabToProvider(
    b,
    'https://psc.synthetic/authorize?state=' + state2,
  );
  for (const c of channels)
    await c.onmessage({
      data: { status: 'connected', attempt: oauth.oauthHash('state', state1) },
    });
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  await channels[1].onmessage({ data: { status: 'connected' } });
  assert.equal(b.closed, false);
  await channels[1].onmessage({
    data: { status: 'connected', attempt: oauth.oauthHash('state', state2) },
  });
  assert.equal(b.closed, true);
});
