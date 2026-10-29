import crypto from 'node:crypto';
import { HttpError } from '../supabase/server.ts';
import { encryptToken, decryptToken } from './crypto-utils.ts';
import { signatureRedirectUri } from './provider-factory.ts';
import type { SignatureProviderId } from './providers.ts';

export const OAUTH_TTL = 300;
export const oauthHash = (purpose: string, value: string) =>
  crypto
    .createHash('sha256')
    .update(`psywrite-psc:${purpose}:${value}`)
    .digest('hex');
export const oauthSecret = () => crypto.randomBytes(32).toString('base64url');
export const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export const validAttempt = (value: string) => /^[a-f0-9]{64}$/.test(value);

// Nunca derive a origem de retorno de Host, query, perfil ou cabeçalhos encaminhados.
export function oauthRedirect(provider: SignatureProviderId) {
  let url: URL;
  try {
    url = new URL(signatureRedirectUri(provider) || '');
  } catch {
    throw new HttpError(503, 'Configure o endereço de retorno do certificado.');
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ![
      '/api/digital-signature/birdid/callback',
      '/api/digital-signature/vidaas/callback',
    ].includes(url.pathname) ||
    (local
      ? !['development', 'test'].includes(process.env.NODE_ENV || '') ||
        !!process.env.VERCEL ||
        !!process.env.VERCEL_ENV ||
        url.protocol !== 'http:'
      : url.protocol !== 'https:')
  )
    throw new HttpError(
      503,
      'Endereço de retorno do certificado não autorizado.',
    );
  return url.href;
}

export function oauthGuard(request: Request, redirectUri: string) {
  const origin = new URL(redirectUri).origin;
  if (
    request.method !== 'POST' ||
    new URL(request.url).origin !== origin ||
    request.headers.get('origin') !== origin ||
    request.headers.get('x-signature-action') !== '1'
  )
    throw new HttpError(403, 'Origem não autorizada.');
}

export function oauthCookieName(
  attempt: string,
  kind: 'binding' | 'transfer',
  origin: string,
) {
  if (!validAttempt(attempt)) throw new HttpError(400, 'Tentativa inválida.');
  return `${new URL(origin).protocol === 'https:' ? '__Host-' : ''}psywrite_psc_${kind}_${attempt}`;
}
export function oauthCookie(
  attempt: string,
  kind: 'binding' | 'transfer',
  value: string,
  origin: string,
  maxAge: number,
) {
  return `${oauthCookieName(attempt, kind, origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
}
export function oauthCookieValue(
  request: Request,
  attempt: string,
  kind: 'binding' | 'transfer',
) {
  const name = oauthCookieName(attempt, kind, new URL(request.url).origin);
  const values = (request.headers.get('cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}

// GET não troca códigos nem escolhe usuários. Apenas transporta o retorno ao POST autenticado.
export function captureOAuthCallback(request: Request) {
  const url = new URL(request.url),
    state = url.searchParams.get('state') || '';
  if (
    !validSecret(state) ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.getAll('code').length > 1 ||
    url.searchParams.getAll('error').length > 1
  )
    throw new HttpError(400, 'Retorno inválido.');
  const attempt = oauthHash('state', state),
    binding = oauthCookieValue(request, attempt, 'binding');
  const code = url.searchParams.get('code') || '',
    cancelled = url.searchParams.has('error');
  if (
    !validSecret(binding) ||
    (!cancelled && (!code || code.length > 1024)) ||
    (cancelled && !!code)
  )
    throw new HttpError(400, 'Contexto do navegador ausente ou inválido.');
  const redirectUri = url.origin + url.pathname;
  const allowed = (['birdid', 'vidaas'] as const).some((provider) => {
    try {
      return oauthRedirect(provider) === redirectUri;
    } catch {
      return false;
    }
  });
  if (!allowed) throw new HttpError(403, 'Origem não autorizada.');
  return {
    attempt,
    transfer: encryptToken(
      JSON.stringify({
        purpose: 'psc-callback-v1',
        state,
        code,
        cancelled,
        bindingHash: oauthHash('browser', binding),
        createdAt: Date.now(),
        redirectUri,
      }),
    ),
  };
}
export function openOAuthCallback(
  attempt: string,
  binding: string,
  transfer: string,
) {
  try {
    if (
      !validAttempt(attempt) ||
      !validSecret(binding) ||
      transfer.length > 16000
    )
      throw Error();
    const value = JSON.parse(decryptToken(transfer));
    if (
      value.purpose !== 'psc-callback-v1' ||
      typeof value.state !== 'string' ||
      !validSecret(value.state) ||
      oauthHash('state', value.state) !== attempt ||
      value.bindingHash !== oauthHash('browser', binding) ||
      !Number.isFinite(value.createdAt) ||
      Date.now() - value.createdAt > 60000 ||
      value.createdAt > Date.now() + 1000 ||
      typeof value.cancelled !== 'boolean' ||
      typeof value.code !== 'string' ||
      (!value.cancelled && !value.code) ||
      typeof value.redirectUri !== 'string'
    )
      throw Error();
    return value as {
      state: string;
      code: string;
      cancelled: boolean;
      redirectUri: string;
    };
  } catch {
    throw new HttpError(
      409,
      'Retorno inválido ou expirado. Inicie nova conexão.',
    );
  }
}
