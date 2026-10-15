// Bird ID e VIDaaS pelo mesmo cliente PSC: cada provedor usa as próprias credenciais e o próprio
// endereço, e a assinatura volta ao provedor que abriu a sessão. O VIDaaS aqui é simulado:
// um fetch falso responde como a API padrão do ITI, com certificado e CMS gerados pelo mock.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Os módulos do servidor importam com "@/"; o Node não conhece esse atalho do tsconfig.
const root = pathToFileURL(resolve(import.meta.dirname, '..') + '/').href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) {
          const path = specifier.slice(2);
          return next(${JSON.stringify(root)} + (/\\.[a-z]+$/.test(path) ? path : path + '.ts'), context);
        }
        return next(specifier, context);
      }`),
  import.meta.url,
);

const {
  configuredSignatureProviders,
  getSignatureProvider,
  signatureRedirectUri,
} = await import('../lib/signature/provider-factory.ts');
const { isSignatureProviderId, signatureProviderLabel } =
  await import('../lib/signature/providers.ts');
const { MockBirdIdProvider } =
  await import('../lib/signature/mock-birdid-provider.ts');

const ENV = [
  'BIRDID_CLIENT_ID',
  'BIRDID_CLIENT_SECRET',
  'BIRDID_BASE_URL',
  'BIRDID_REDIRECT_URI',
  'VIDAAS_CLIENT_ID',
  'VIDAAS_CLIENT_SECRET',
  'VIDAAS_BASE_URL',
  'VIDAAS_REDIRECT_URI',
  'SIGNATURE_PROVIDER',
];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const clearEnv = () => ENV.forEach((key) => delete process.env[key]);
const realFetch = globalThis.fetch;

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = realFetch;
});

describe('provedores de certificado em nuvem', () => {
  before(clearEnv);

  it('lista só os provedores com credenciais, na ordem fixa', () => {
    clearEnv();
    assert.deepEqual(configuredSignatureProviders(), []);
    process.env.VIDAAS_CLIENT_ID = 'vidaas-app';
    assert.deepEqual(
      configuredSignatureProviders(),
      [],
      'sem o segredo não conta',
    );
    process.env.VIDAAS_CLIENT_SECRET = 'vidaas-secret';
    assert.deepEqual(configuredSignatureProviders(), ['vidaas']);
    process.env.BIRDID_CLIENT_ID = 'bird-app';
    process.env.BIRDID_CLIENT_SECRET = 'bird-secret';
    assert.deepEqual(configuredSignatureProviders(), ['birdid', 'vidaas']);
  });

  it('recusa provedor desconhecido ou sem credenciais, com o nome dele na mensagem', () => {
    clearEnv();
    assert.throws(
      () => getSignatureProvider('vidaas'),
      (error) => {
        assert.equal(error.status, 503);
        assert.match(error.message, /VIDaaS/);
        return true;
      },
    );
    assert.throws(() => getSignatureProvider('soluti'), { status: 500 });
  });

  it('o mock só existe em teste, para qualquer provedor pedido', () => {
    clearEnv();
    process.env.SIGNATURE_PROVIDER = 'mock';
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      assert.ok(getSignatureProvider('vidaas') instanceof MockBirdIdProvider);
      process.env.NODE_ENV = 'production';
      assert.throws(() => getSignatureProvider('vidaas'), { status: 503 });
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.SIGNATURE_PROVIDER;
    }
  });

  it('cada provedor monta o login no próprio endereço e com o próprio client_id', () => {
    clearEnv();
    process.env.BIRDID_CLIENT_ID = 'bird-app';
    process.env.BIRDID_CLIENT_SECRET = 'bird-secret';
    process.env.VIDAAS_CLIENT_ID = 'vidaas-app';
    process.env.VIDAAS_CLIENT_SECRET = 'vidaas-secret';
    const params = {
      state: 'estado',
      codeChallenge: 'desafio',
      redirectUri:
        'https://psywrite.example/api/digital-signature/birdid/callback',
      loginHint: '349.291.448-92',
      lifetimeSeconds: 14400,
    };
    const bird = new URL(
      getSignatureProvider('birdid').getAuthorizationUrl(params),
    );
    const vidaas = new URL(
      getSignatureProvider('vidaas').getAuthorizationUrl(params),
    );

    assert.equal(
      bird.origin + bird.pathname,
      'https://api.birdid.com.br/v0/oauth/authorize',
    );
    assert.equal(
      vidaas.origin + vidaas.pathname,
      'https://certificado.vidaas.com.br/v0/oauth/authorize',
    );
    assert.equal(bird.searchParams.get('client_id'), 'bird-app');
    assert.equal(vidaas.searchParams.get('client_id'), 'vidaas-app');
    for (const url of [bird, vidaas]) {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('scope'), 'signature_session');
      assert.equal(url.searchParams.get('login_hint'), '34929144892');
      assert.equal(url.searchParams.get('lifetime'), '14400');
    }

    process.env.VIDAAS_BASE_URL = 'https://hml-certificado.vidaas.com.br/v0/';
    process.env.VIDAAS_REDIRECT_URI = 'https://psywrite.example/retorno';
    const homolog = new URL(
      getSignatureProvider('vidaas').getAuthorizationUrl(params),
    );
    assert.equal(homolog.host, 'hml-certificado.vidaas.com.br');
    assert.equal(homolog.pathname, '/v0/oauth/authorize');
    assert.equal(
      signatureRedirectUri('vidaas'),
      'https://psywrite.example/retorno',
    );
    assert.equal(signatureRedirectUri('birdid'), null);
  });

  it('VIDaaS simulado: troca o código, lê o certificado e assina o hash', async () => {
    clearEnv();
    process.env.VIDAAS_CLIENT_ID = 'vidaas-app';
    process.env.VIDAAS_CLIENT_SECRET = 'vidaas-secret';
    const psc = new MockBirdIdProvider({
      mockCpf: '34929144892',
      doctorName: 'DRA TESTE',
    });
    const [certificate] = await psc.getCertificates('');
    const hashHex = 'ab'.repeat(32);
    const { cmsSignatureBase64 } = await psc.signHash({
      accessToken: '',
      certificateAlias: certificate.alias,
      hashHex,
      documentAlias: 'teste',
    });

    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({
        path: url.pathname,
        host: url.host,
        headers: init.headers,
        body,
      });
      const reply = (data, status = 200) => Response.json(data, { status });
      if (url.pathname === '/v0/oauth/token')
        return reply({
          access_token: 'token-vidaas',
          expires_in: '14400',
          token_type: 'Bearer',
          authorized_identification: '34929144892',
        });
      if (url.pathname === '/v0/oauth/certificate-discovery')
        return reply({
          status: 'S',
          certificates: [
            { alias: certificate.alias, certificate: certificate.rawPem },
          ],
        });
      if (url.pathname === '/v0/oauth/signature')
        return body.hashes[0].hash === hashHex
          ? reply({
              signatures: [{ id: 'tx-1', raw_signature: cmsSignatureBase64 }],
            })
          : reply({ error: 'hash_invalido' }, 400);
      return reply({ error: 'not_found' }, 404);
    };

    const vidaas = getSignatureProvider('vidaas');
    const token = await vidaas.exchangeAuthorizationCode({
      code: 'codigo',
      codeVerifier: 'verificador',
      redirectUri: 'https://psywrite.example/retorno',
    });
    assert.deepEqual(token, {
      accessToken: 'token-vidaas',
      expiresIn: 14400,
      tokenType: 'Bearer',
      cpf: '34929144892',
    });
    const [found] = await vidaas.getCertificates(token.accessToken);
    assert.equal(found.cpf, '34929144892');
    assert.equal(found.fingerprint256, certificate.fingerprint256);

    const signed = await vidaas.signHash({
      accessToken: token.accessToken,
      certificateAlias: found.alias,
      hashHex,
      documentAlias: 'Evolução Clínica #1',
    });
    assert.equal(signed.cmsSignatureBase64, cmsSignatureBase64);
    assert.equal(signed.providerTransactionId, 'tx-1');

    assert.ok(calls.every((call) => call.host === 'certificado.vidaas.com.br'));
    const tokenCall = calls.find((call) => call.path === '/v0/oauth/token');
    assert.equal(
      tokenCall.headers.Authorization,
      `Basic ${Buffer.from('vidaas-app:vidaas-secret').toString('base64')}`,
    );
    assert.equal(tokenCall.body.code_verifier, 'verificador');
    const signCall = calls.find((call) => call.path === '/v0/oauth/signature');
    assert.equal(signCall.headers.Authorization, 'Bearer token-vidaas');
    assert.equal(signCall.body.hashes[0].signature_format, 'CMS');
    assert.equal(
      signCall.body.hashes[0].hash_algorithm,
      '2.16.840.1.101.3.4.2.1',
    );

    await assert.rejects(
      vidaas.signHash({
        accessToken: token.accessToken,
        certificateAlias: found.alias,
        hashHex: 'cd'.repeat(32),
        documentAlias: 'outro',
      }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /VIDaaS/);
        return true;
      },
    );
  });

  it('nomes para a tela', () => {
    assert.equal(signatureProviderLabel('birdid'), 'Bird ID');
    assert.equal(signatureProviderLabel('vidaas'), 'VIDaaS');
    assert.equal(signatureProviderLabel('mock'), 'mock');
    assert.equal(signatureProviderLabel(undefined), 'certificado em nuvem');
    assert.ok(isSignatureProviderId('vidaas'));
    assert.ok(!isSignatureProviderId('toString'));
  });
});
