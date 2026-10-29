// PostgREST real no namespace de rede isolado do PostgreSQL descartável.
// JWTs são assinados por segredo efêmero local; não utiliza GoTrue nem chaves reais.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { containerEngine } from './sncr-container.mjs';

export async function startSignatureTrustRest(h) {
  const image = process.env.SIGNATURE_TEST_REST_IMAGE || 'public.ecr.aws/supabase/postgrest:v16.2';
  if (!['public.ecr.aws/supabase/postgrest:v16.2', 'public.ecr.aws/supabase/postgrest:v14.5'].includes(image))
    throw Error('Imagem PostgREST local não autorizada.');
  const suffix = randomBytes(6).toString('hex');
  const gateway = `signature_gateway_${suffix}`;
  const secret = randomBytes(32).toString('hex');
  const password = randomBytes(24).toString('hex');
  const name = `psywrite-signature-rest-6c-${suffix}`;
  h.sql(
    `create role ${gateway} login noinherit password ${h.lit(password)};
    grant anon,authenticated,service_role to ${gateway};`,
    { role: 'supabase_admin' },
  );
  let container;
  const cleanup = () => {
    if (container)
      execFileSync(containerEngine, ['rm', '-f', container], { stdio: 'pipe' });
    h.sql(`drop role ${gateway};`, { role: 'supabase_admin' });
  };
  try {
    container = execFileSync(
      containerEngine,
      [
        'run',
        '-d',
        '--pull=never',
        '--name',
        name,
        '--label',
        'psywrite.test=lote-6c',
        '--network',
        `container:${h.container}`,
        '-e',
        `PGRST_DB_URI=postgres://${gateway}:${password}@127.0.0.1:5432/${h.database}`,
        '-e',
        'PGRST_DB_SCHEMAS=public',
        '-e',
        'PGRST_DB_ANON_ROLE=anon',
        '-e',
        `PGRST_JWT_SECRET=${secret}`,
        '-e',
        'PGRST_SERVER_HOST=127.0.0.1',
        '-e',
        'PGRST_SERVER_PORT=31006',
        image,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    const jwt = (role, sub, claims = {}) => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          role,
          ...(sub ? { sub } : {}),
          ...claims,
          aal: 'aal2',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const unsigned = `${header}.${payload}`;
      return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
    };
    async function fetchRest(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== 'http://signature.synthetic' ||
        !url.pathname.startsWith('/rest/v1/')
      )
        throw Error('Destino não local bloqueado.');
      const args = [
        'exec',
        '-i',
        h.container,
        'curl',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--request',
        request.method,
        '--write-out',
        '\n%{http_code}',
        `http://127.0.0.1:31006/${url.pathname.slice('/rest/v1/'.length)}${url.search}`,
      ];
      for (const [key, value] of request.headers)
        if (!['host', 'content-length', 'connection'].includes(key))
          args.push('--header', `${key}: ${value}`);
      const body = ['GET', 'HEAD'].includes(request.method)
        ? null
        : Buffer.from(await request.arrayBuffer());
      if (body) args.push('--data-binary', '@-');
      const result = String(
        execFileSync(containerEngine, args, {
          input: body,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        }),
      );
      const split = result.lastIndexOf('\n');
      const status = Number(result.slice(split + 1));
      return new Response(
        [204, 205, 304].includes(status) ? null : result.slice(0, split),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    for (let i = 0; ; i++) {
      try {
        const result = await fetchRest('http://signature.synthetic/rest/v1/', {
          headers: { authorization: `Bearer ${jwt('anon')}` },
        });
        if (result.ok) break;
      } catch {
        /* O processo local ainda está inicializando. */
      }
      if (i >= 25) throw Error('PostgREST descartável não ficou disponível.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { jwt, fetch: fetchRest, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
