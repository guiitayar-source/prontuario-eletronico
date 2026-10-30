import { handle, HttpError, json } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';
import { configuredSignatureProviders } from '@/lib/signature/provider-factory';
import { isSignatureProviderId } from '@/lib/signature/providers';
import {
  oauthRedirect,
  oauthGuard,
  oauthSecret,
  oauthHash,
  oauthCookie,
  OAUTH_TTL,
} from '@/lib/signature/oauth-context';
export const dynamic = 'force-dynamic';
export const POST = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role) || !ctx.authSessionId)
    throw new HttpError(
      403,
      'Apenas médicos com sessão válida podem autorizar assinaturas.',
    );
  const url = new URL(request.url);
  const provider =
    url.searchParams.get('provider') ||
    configuredSignatureProviders()[0] ||
    'birdid';
  if (!isSignatureProviderId(provider))
    throw new HttpError(400, 'Provedor desconhecido.');
  const redirectUri = oauthRedirect(provider);
  oauthGuard(request, redirectUri);
  const binding = oauthSecret();
  const result = await documentSigningService.initiateOAuthSession({
    db: ctx.db,
    clinicId: ctx.clinic,
    userId: ctx.user,
    authSessionId: ctx.authSessionId,
    binding,
    provider,
  });
  const response = json({ authorizationUrl: result.authorizationUrl });
  response.headers.append(
    'Set-Cookie',
    oauthCookie(
      oauthHash('state', result.state),
      'binding',
      binding,
      redirectUri,
      OAUTH_TTL,
    ),
  );
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});
