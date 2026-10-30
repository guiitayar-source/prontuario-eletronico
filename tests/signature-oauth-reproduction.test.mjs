// Reproduções anteriores à correção. Transporte PSC inteiramente sintético.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { encryptToken } from '../lib/signature/crypto-utils.ts';
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
const { captureOAuthCallback, oauthCookie } =
  await import('../lib/signature/oauth-context.ts');
after(() => setCustomSignatureProvider(null));
function fixture() {
  const provider = new MockBirdIdProvider({ mockCpf: '52998224725' });
  let calls = 0,
    consumed = false;
  const state = {
    id: 'synthetic',
    clinic_id: 'clinic',
    user_id: 'doctor',
    provider: 'birdid',
    code_verifier_encrypted: encryptToken('synthetic-verifier'),
    redirect_uri:
      'https://psywrite.example/api/digital-signature/birdid/callback',
  };
  const db = {
    from(table) {
      let value,
        removing = false;
      const q = {
        select: () => q,
        eq: () => q,
        gt: () => q,
        update: () => q,
        delete() {
          removing = true;
          return q;
        },
        insert(v) {
          value = v;
          return q;
        },
        async maybeSingle() {
          return {
            data:
              table === 'signature_oauth_states'
                ? consumed
                  ? null
                  : state
                : { cpf: '52998224725' },
            error: null,
          };
        },
        async single() {
          return { data: { id: 'synthetic-session', ...value }, error: null };
        },
        // eslint-disable-next-line unicorn/no-thenable -- Contrato Supabase.
        then(resolve, reject) {
          if (removing) consumed = true;
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  setCustomSignatureProvider({
    async exchangeAuthorizationCode() {
      calls++;
      return { accessToken: 'synthetic-token', expiresIn: 3600 };
    },
    getCertificates: (t) => provider.getCertificates(t),
  });
  const complete = (extra) =>
    new DocumentSigningService(() => db).handleOAuthCallback({
      db,
      clinicId: 'clinic',
      userId: 'doctor',
      code: 'synthetic-code',
      state: 'synthetic-state',
      ...extra,
    });
  return { complete, calls: () => calls };
}
test('callback sem prova de navegador não pode trocar código', async () => {
  const f = fixture();
  await assert.rejects(f.complete({ binding: '' }));
  assert.equal(f.calls(), 0);
});
test('callback sem sessão PsyWrite vinculada não pode trocar código', async () => {
  const f = fixture();
  await assert.rejects(f.complete({ authSessionId: '' }));
  assert.equal(f.calls(), 0);
});
test('callbacks concorrentes não podem iniciar duas trocas externas', async () => {
  const f = fixture();
  await Promise.allSettled([f.complete(), f.complete()]);
  assert.ok(f.calls() <= 1);
});
test('GET do callback não associa usuário somente pelo state persistido', async () => {
  const source = readFileSync(
    new URL(
      '../app/api/digital-signature/birdid/callback/route.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'route.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
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
  let calls = 0;
  const exports = {};
  const q = {
    select: () => q,
    eq: () => q,
    gt: () => q,
    maybeSingle: async () => ({
      data: { clinic_id: 'clinic', user_id: 'doctor' },
    }),
  };
  runInNewContext(js, {
    exports,
    URL,
    Response,
    Headers,
    captureOAuthCallback,
    oauthCookie,
    crypto: await import('node:crypto'),
    adminClient: () => ({ from: () => q }),
    documentSigningService: {
      handleOAuthCallback: async () => {
        calls++;
      },
    },
  });
  await exports.GET(
    new Request(
      'https://psywrite.example/api/digital-signature/birdid/callback?state=synthetic&code=synthetic-code',
    ),
  );
  assert.equal(calls, 0);
});
