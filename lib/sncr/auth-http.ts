import { HttpError } from '../supabase/server.ts';
import { SNCR_API, type SncrAuthConfig } from './auth-config.ts';

export class SncrAuthError extends HttpError {
  readonly reason:
    | 'unauthorized'
    | 'forbidden'
    | 'unavailable'
    | 'uncertain'
    | 'invalid_response';
  constructor(reason: SncrAuthError['reason'], status: number) {
    super(
      status,
      {
        unauthorized:
          'Sessão SNCR rejeitada ou expirada; autentique novamente.',
        forbidden: 'Autorização SNCR recusada. Confira seu cadastro no órgão.',
        unavailable:
          'SNCR indisponível. Nenhuma autorização provisória foi concedida.',
        uncertain:
          'Troca de sessão com resultado incerto. Não repetir; inicie nova autenticação.',
        invalid_response:
          'Resposta de autenticação SNCR inválida. Operação bloqueada.',
      }[reason],
    );
    this.reason = reason;
  }
}
// Sem retries, redirects, refresh inventado ou interpolação de respostas externas em erros.
export async function exchangeSncrSession(
  config: SncrAuthConfig,
  sessionId: string,
  transport: typeof fetch = fetch,
) {
  const url = new URL('auth/token', SNCR_API[config.environment]);
  url.searchParams.set('session_id', sessionId);
  let response: Response;
  const requestedAt = Date.now();
  try {
    response = await transport(url, {
      method: 'GET',
      headers: { Origin: config.origin, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new SncrAuthError('uncertain', 503);
  }
  if (response.status === 401) throw new SncrAuthError('unauthorized', 401);
  if (response.status === 403) throw new SncrAuthError('forbidden', 403);
  if (!response.ok) throw new SncrAuthError('unavailable', 503);
  let data: { access_token?: unknown; token_type?: unknown };
  try {
    // Limite também quando Content-Length não é enviado; cancela streams excessivos.
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw Error();
      }
      chunks.push(part.value);
    }
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !data ||
      typeof data !== 'object' ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      data.access_token.length > 16384 ||
      /[^\x21-\x7e]/.test(data.access_token) ||
      data.token_type !== 'Bearer'
    )
      throw Error();
  } catch {
    throw new SncrAuthError('invalid_response', 503);
  }
  // Manual §2.2.4.4: 30 segundos, sem refresh. Não decodificar JWT como prova de identidade.
  const expiresAt = requestedAt + 30000;
  if (expiresAt <= Date.now()) throw new SncrAuthError('unauthorized', 401);
  return {
    token: data.access_token as string,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
