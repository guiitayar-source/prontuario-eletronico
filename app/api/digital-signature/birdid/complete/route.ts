import { context, HttpError, json, body } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';
import {
  oauthGuard,
  oauthCookieValue,
  oauthCookie,
  openOAuthCallback,
  validAttempt,
} from '@/lib/signature/oauth-context';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let attempt = '',
    response: Response;
  try {
    const input = await body(request);
    attempt = typeof input.attempt === 'string' ? input.attempt : '';
    if (!validAttempt(attempt)) throw new HttpError(400, 'Tentativa inválida.');
    const binding = oauthCookieValue(request, attempt, 'binding');
    const envelope = openOAuthCallback(
      attempt,
      binding,
      oauthCookieValue(request, attempt, 'transfer'),
    );
    oauthGuard(request, envelope.redirectUri);
    const ctx = await context(request);
    if (!['owner', 'doctor'].includes(ctx.role) || !ctx.authSessionId)
      throw new HttpError(403, 'Sessão médica válida obrigatória.');
    await documentSigningService.handleOAuthCallback({
      db: ctx.db,
      clinicId: ctx.clinic,
      userId: ctx.user,
      authSessionId: ctx.authSessionId,
      binding,
      ...envelope,
    });
    response = json({ status: 'connected' });
  } catch (error) {
    response = json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : 'Não foi possível concluir a autorização.',
      },
      error instanceof HttpError
        ? error.status === 401
          ? 409
          : error.status
        : 503,
    );
  }
  if (validAttempt(attempt))
    for (const kind of ['binding', 'transfer'] as const)
      response.headers.append(
        'Set-Cookie',
        oauthCookie(attempt, kind, '', request.url, 0),
      );
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
