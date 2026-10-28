import { context, json, writeGuard, HttpError } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { SncrSessions } from '@/lib/sncr/sessions';
import {
  AUTH_COOKIE,
  TRANSFER_COOKIE,
  cookieValue,
  authCookie,
  sncrAuthConfig,
} from '@/lib/sncr/auth-config';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let response: Response;
  try {
    writeGuard(request, 'x-sncr-action');
    const ctx = await context(request);
    if (!['owner', 'doctor'].includes(ctx.role))
      throw new HttpError(403, 'Acesso restrito à equipe médica.');
    const config = sncrAuthConfig();
    if (new URL(request.url).origin !== config.origin)
      throw new HttpError(403, 'Origem não autorizada.');
    response = json(
      await new SncrSessions(adminClient()).complete(
        { clinicId: ctx.clinic, userId: ctx.user },
        cookieValue(request, AUTH_COOKIE),
        cookieValue(request, TRANSFER_COOKIE),
        config,
      ),
    );
  } catch (error) {
    // 409 evita que apiFetch repita automaticamente a troca de uso único por um 401 externo.
    response = json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : 'Não foi possível concluir a conexão SNCR.',
      },
      error instanceof HttpError
        ? error.status === 401
          ? 409
          : error.status
        : 503,
    );
  }
  for (const name of [AUTH_COOKIE, TRANSFER_COOKIE])
    response.headers.append(
      'Set-Cookie',
      authCookie(name, '', new URL(request.url).origin, 0),
    );
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
