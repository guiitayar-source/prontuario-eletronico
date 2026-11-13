// Papéis nas rotas clínicas: secretária (ou papel desconhecido) é recusada com 403 e a mensagem
// própria de cada rota, antes de qualquer acesso a dados; owner e doctor passam da checagem.
// Autenticação e banco sintéticos: qualquer HTTP fora do login e do vínculo é bloqueado.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const root = new URL('../', import.meta.url).href;
// Resolve '@/' como o Next e importa os catálogos .json da CID (o Next dispensa o atributo de tipo).
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s,c,next){if(s.startsWith('@/'))s=new URL(s.slice(2)+(/\\.[a-z]+$/.test(s)?'':'.ts'),${JSON.stringify(root)}).href;const r=await next(s,c);return r.url.endsWith('.json')?{...r,importAttributes:{type:'json'}}:r;}`,
    ),
  import.meta.url,
);

const base = 'https://psywrite.synthetic';
const actor = '10000000-0000-4000-8000-000000000001';
const clinic = '20000000-0000-4000-8000-000000000001';
const sessionId = '50000000-0000-4000-8000-000000000001';
const envKeys = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SIGNATURE_ENCRYPTION_KEY',
  'BIRDID_REDIRECT_URI',
];
const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;
Object.assign(process.env, {
  NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public',
  SIGNATURE_ENCRYPTION_KEY: 'synthetic-roles-only',
  BIRDID_REDIRECT_URI: base + '/api/digital-signature/birdid/callback',
});

// Papel de quem chama; `rest` responde caminhos extras num teste; `blocked` guarda o que foi barrado.
// O barrado recebe um erro que o cliente do Supabase não repete (falha de rede ele repete com espera).
let role = 'secretary',
  rest = {},
  blocked = [];
const seen = [];
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== 'https://synthetic.invalid') {
    blocked.push(url.href);
    return Response.json(
      { message: 'HTTP inesperado bloqueado' },
      { status: 418 },
    );
  }
  seen.push(url.pathname);
  switch (url.pathname) {
    case '/auth/v1/user':
      return Response.json({ id: actor, aud: 'authenticated' });
    case '/rest/v1/clinic_members':
      return Response.json([{ clinic_id: clinic, role }]);
    case '/rest/v1/rpc/session_is_strong':
      return Response.json(true);
  }
  if (url.pathname in rest) return Response.json(rest[url.pathname]);
  blocked.push(url.pathname);
  return Response.json(
    { code: 'TESTE', message: 'HTTP inesperado bloqueado' },
    { status: 418 },
  );
};
after(() => {
  globalThis.fetch = originalFetch;
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  rest = {};
  blocked = [];
  seen.length = 0;
});

const route = (path) => import(`../app/api/${path}/route.ts`);
// Bearer com session_id, como o do Supabase (só lido depois que /auth/v1/user aceita o token).
const withSession =
  'x.' +
  Buffer.from(JSON.stringify({ sub: actor, session_id: sessionId })).toString(
    'base64url',
  ) +
  '.y';
function request(
  method,
  path,
  { token = 'synthetic-token', headers = {}, body } = {},
) {
  const init = {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      origin: base,
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (method === 'POST') init.body = JSON.stringify(body ?? {});
  return new Request(base + path, init);
}

// Rota, método e a mensagem de recusa de hoje. As rotas de assinatura checam a origem antes do
// papel; por isso levam o cabeçalho de ação.
const sign = { 'x-signature-action': '1' };
const guarded = [
  {
    path: 'exams',
    method: 'GET',
    message: 'Resultados disponíveis à equipe médica.',
  },
  {
    path: 'exams',
    method: 'POST',
    message: 'Resultados disponíveis à equipe médica.',
  },
  {
    path: 'consultations',
    method: 'GET',
    message: 'O acesso às evoluções é exclusivo da equipe médica.',
  },
  {
    path: 'consultations',
    method: 'POST',
    message: 'O acesso às evoluções é exclusivo da equipe médica.',
  },
  {
    path: 'clinical-context',
    method: 'GET',
    message: 'O contexto clínico é exclusivo da equipe médica.',
  },
  {
    path: 'clinical-context',
    method: 'POST',
    message: 'O contexto clínico é exclusivo da equipe médica.',
  },
  {
    path: 'documents',
    method: 'GET',
    message: 'Documentos clínicos são exclusivos da equipe médica.',
  },
  {
    path: 'documents',
    method: 'POST',
    message: 'Documentos clínicos são exclusivos da equipe médica.',
  },
  { path: 'audit', method: 'GET', message: 'Auditoria restrita a médicos.' },
  {
    path: 'imports',
    method: 'GET',
    message:
      'A importação e o histórico clínico são exclusivos da equipe médica.',
  },
  {
    path: 'imports',
    method: 'POST',
    message:
      'A importação e o histórico clínico são exclusivos da equipe médica.',
  },
  {
    path: 'anamnesator',
    method: 'GET',
    message: 'Acesso exclusivo da equipe médica.',
  },
  {
    path: 'anamnesator',
    method: 'POST',
    message: 'Acesso exclusivo da equipe médica.',
  },
  {
    path: 'fhir',
    method: 'GET',
    message: 'Exportação disponível somente para médicos.',
  },
  {
    path: 'fhir',
    method: 'POST',
    message: 'Exportação disponível somente para médicos.',
  },
  {
    path: 'document-ai',
    method: 'GET',
    message: 'A geração de documentos é exclusiva da equipe médica.',
  },
  {
    path: 'document-ai',
    method: 'POST',
    message: 'A geração de documentos é exclusiva da equipe médica.',
  },
  {
    path: 'ai-files',
    method: 'GET',
    message: 'Leitura por IA disponível somente à equipe médica.',
  },
  {
    path: 'ai-files',
    method: 'POST',
    message: 'Leitura por IA disponível somente à equipe médica.',
  },
  {
    path: 'sncr/rce',
    method: 'GET',
    message: 'A receita eletrônica numerada é exclusiva do prescritor.',
  },
  {
    path: 'sncr/rce',
    method: 'POST',
    message: 'A receita eletrônica numerada é exclusiva do prescritor.',
  },
  {
    path: 'sncr',
    method: 'GET',
    message: 'Apenas prescritores podem utilizar o SNCR.',
  },
  {
    path: 'sncr',
    method: 'POST',
    message: 'Apenas prescritores podem utilizar o SNCR.',
  },
  {
    path: 'cid',
    method: 'GET',
    message: 'Diagnósticos são exclusivos da equipe médica.',
  },
  {
    path: 'capture?action=archived&patientId=p1',
    method: 'GET',
    message: 'Acesso restrito ao médico.',
  },
  {
    path: 'digital-signature/evolution-details',
    method: 'GET',
    message:
      'Apenas médicos têm acesso aos detalhes de assinatura de evoluções.',
  },
  {
    path: 'digital-signature/providers',
    method: 'GET',
    message: 'Apenas médicos têm acesso a sessões de assinatura.',
  },
  {
    path: 'digital-signature/session',
    method: 'GET',
    message: 'Apenas médicos têm acesso a sessões de assinatura.',
  },
  {
    path: 'digital-signature/session',
    method: 'DELETE',
    message: 'Apenas médicos têm acesso a sessões de assinatura.',
  },
  {
    path: 'digital-signature/sign-evolution',
    method: 'POST',
    message: 'Apenas médicos podem assinar evoluções clínicas.',
    headers: sign,
  },
  {
    path: 'digital-signature/sign',
    method: 'POST',
    message: 'Apenas médicos podem assinar documentos clínicos.',
    headers: sign,
  },
  {
    path: 'digital-signature/test-sign',
    method: 'POST',
    message: 'Apenas médicos têm permissão para assinar documentos.',
  },
  {
    path: 'digital-signature/test-sign',
    method: 'GET',
    message: 'Apenas médicos têm acesso aos testes de assinatura.',
  },
  {
    path: 'digital-signature/birdid/authorize',
    method: 'POST',
    message: 'Apenas médicos com sessão válida podem autorizar assinaturas.',
  },
];

async function call(path, method, headers) {
  const routeModule = await route(path.split('?')[0]);
  assert.equal(
    typeof routeModule[method],
    'function',
    `${path} não exporta ${method}`,
  );
  const response = await routeModule[method](
    request(method, '/api/' + path, { token: withSession, headers }),
  );
  return {
    status: response.status,
    error: (await response.json().catch(() => ({}))).error,
  };
}

for (const { path, method, message, headers } of guarded) {
  test(`${method} /api/${path} recusa quem não é da equipe médica`, async () => {
    for (const r of ['secretary', 'papel-desconhecido']) {
      role = r;
      blocked = [];
      assert.deepEqual(
        await call(path, method, headers),
        { status: 403, error: message },
        r,
      );
      assert.deepEqual(
        blocked,
        [],
        `${r}: a recusa deve vir antes de qualquer acesso a dados`,
      );
    }
  });
  test(`${method} /api/${path} deixa owner e doctor passarem da checagem de papel`, async () => {
    for (const r of ['owner', 'doctor']) {
      role = r;
      const result = await call(path, method, headers);
      assert.notEqual(result.error, message, r);
    }
  });
}

test('Bird ID: médico sem session_id no token também é recusado ao autorizar', async () => {
  const { POST } = await route('digital-signature/birdid/authorize');
  for (const r of ['owner', 'doctor']) {
    role = r;
    const response = await POST(
      request('POST', '/api/digital-signature/birdid/authorize'),
    );
    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).error,
      'Apenas médicos com sessão válida podem autorizar assinaturas.',
    );
    assert.deepEqual(blocked, []);
  }
});

// A conclusão do Bird ID abre o envelope do retorno (cookies) antes de checar o papel: monta um
// envelope válido para chegar à checagem.
async function completeRequest(token) {
  const oauth = await import('../lib/signature/oauth-context.ts');
  const state = oauth.oauthSecret(),
    binding = oauth.oauthSecret();
  const attempt = oauth.oauthHash('state', state);
  const bindingCookie =
    oauth.oauthCookieName(attempt, 'binding', base) + '=' + binding;
  const envelope = oauth.captureOAuthCallback(
    new Request(
      process.env.BIRDID_REDIRECT_URI + '?code=SYNTHETIC_CODE&state=' + state,
      { headers: { cookie: bindingCookie } },
    ),
  );
  const cookie =
    bindingCookie +
    '; ' +
    oauth.oauthCookieName(attempt, 'transfer', base) +
    '=' +
    envelope.transfer;
  return request('POST', '/api/digital-signature/birdid/complete', {
    token,
    headers: { ...sign, cookie },
    body: { attempt: envelope.attempt },
  });
}

test('Bird ID: conclusão recusa secretária e médico sem sessão; owner e doctor com sessão passam', async () => {
  const { POST } = await route('digital-signature/birdid/complete');
  const refused = { status: 403, error: 'Sessão médica válida obrigatória.' };
  const outcome = async (r, token) => {
    role = r;
    const response = await POST(await completeRequest(token));
    return { status: response.status, error: (await response.json()).error };
  };
  for (const r of ['secretary', 'papel-desconhecido']) {
    blocked = [];
    assert.deepEqual(await outcome(r, withSession), refused, r);
    assert.deepEqual(blocked, [], r);
  }
  for (const r of ['owner', 'doctor']) {
    assert.deepEqual(
      await outcome(r, 'synthetic-token'),
      refused,
      `${r} sem sessão`,
    );
    assert.notEqual(
      (await outcome(r, withSession)).error,
      refused.error,
      `${r} com sessão`,
    );
  }
});

test('anexos: a lista não consulta exames para a secretária; para owner e doctor marca os com exame', async () => {
  const { GET } = await route('capture');
  const list = async (r) => {
    role = r;
    rest = {
      '/rest/v1/patients': [{ id: 'p1', clinic_id: clinic }],
      '/rest/v1/attachments': [
        {
          id: 'a1',
          request_id: null,
          name: 'exame.pdf',
          mime: 'application/pdf',
          size: 10,
          category: null,
          created_at: '2026-11-12T10:00:00Z',
        },
      ],
      '/rest/v1/exam_results': [{ attachment_id: 'a1', provenance: null }],
    };
    seen.length = 0;
    const response = await GET(
      request('GET', '/api/capture?action=list&patientId=p1'),
    );
    assert.equal(response.status, 200, r);
    return {
      exams: seen.includes('/rest/v1/exam_results'),
      hasExams: (await response.json()).attachments[0].has_exams,
    };
  };
  assert.deepEqual(await list('secretary'), { exams: false, hasExams: false });
  assert.deepEqual(await list('owner'), { exams: true, hasExams: true });
  assert.deepEqual(await list('doctor'), { exams: true, hasExams: true });
});
