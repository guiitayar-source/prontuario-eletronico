import { HttpError } from '../supabase/server.ts';

// Manual SNCR, 3ª edição, §§2.1–2.2. Não usar o OAuth de serviço do Swagger.
export const SNCR_API = Object.freeze({
  hmg: 'https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/api/v1/',
  prd: 'https://api-gateway.prd.apps.anvisa.gov.br/api-sncr/api/v1/',
});
export type SncrEnvironment = keyof typeof SNCR_API;
export type SncrAuthConfig = {
  environment: SncrEnvironment;
  callback: string;
  origin: string;
};
export function sncrAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): SncrAuthConfig {
  if (
    env.PSYWRITE_SNCR_AUTH_MODE !== 'homologation' ||
    (env.ANVISA_SNCR_ENV || 'hmg') !== 'hmg'
  )
    throw new HttpError(
      503,
      'Conexão SNCR desabilitada. Produção e emissão real permanecem bloqueadas.',
    );
  let url: URL;
  try {
    url = new URL(env.PSYWRITE_SNCR_CALLBACK_URL || '');
  } catch {
    throw new HttpError(503, 'URL de retorno SNCR não configurada.');
  }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  const local =
    loopback &&
    ['development', 'test'].includes(env.NODE_ENV || '') &&
    !env.VERCEL &&
    !env.VERCEL_ENV;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/sncr/auth/callback' ||
    !(local
      ? url.protocol === 'http:'
      : url.protocol === 'https:' &&
        url.hostname.endsWith('.br') &&
        !loopback &&
        !url.port)
  )
    throw new HttpError(
      503,
      'URL de retorno SNCR não autorizada: utilize HTTPS em domínio .br ou localhost local.',
    );
  return { environment: 'hmg', callback: url.href, origin: url.origin };
}

export const AUTH_COOKIE = 'psywrite_sncr_binding';
export const TRANSFER_COOKIE = 'psywrite_sncr_callback';
export function authCookie(
  name: string,
  value: string,
  origin: string,
  maxAge: number,
) {
  return `${name}=${value}; Path=/api/sncr/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
}
export function cookieValue(request: Request, name: string) {
  const values = (request.headers.get('cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
