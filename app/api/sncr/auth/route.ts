import { handle, json, writeGuard, HttpError } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { SncrSessions } from '@/lib/sncr/sessions';
import {
  AUTH_COOKIE,
  TRANSFER_COOKIE,
  authCookie,
  sncrAuthConfig,
} from '@/lib/sncr/auth-config';

export const dynamic = 'force-dynamic';
const medical = (role: string) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(403, 'Acesso restrito à equipe médica.');
};
export const GET = handle(async (_request, ctx) => {
  medical(ctx.role);
  if (process.env.PSYWRITE_SNCR_AUTH_MODE !== 'homologation')
    return json({ state: 'disabled', realIssuanceEnabled: false });
  const config = sncrAuthConfig();
  return json({
    ...(await new SncrSessions(adminClient()).status(
      { clinicId: ctx.clinic, userId: ctx.user },
      config.environment,
    )),
    realIssuanceEnabled: false,
  });
});
export const POST = handle(async (request, ctx) => {
  writeGuard(request, 'x-sncr-action');
  medical(ctx.role);
  const config = sncrAuthConfig();
  if (new URL(request.url).origin !== config.origin)
    throw new HttpError(403, 'Origem de autenticação não autorizada.');
  const started = await new SncrSessions(adminClient()).start(
    { clinicId: ctx.clinic, userId: ctx.user },
    config,
  );
  const response = json({ authorizationUrl: started.authorizationUrl });
  response.headers.append(
    'Set-Cookie',
    authCookie(AUTH_COOKIE, started.binding, config.origin, 300),
  );
  response.headers.append(
    'Set-Cookie',
    authCookie(TRANSFER_COOKIE, '', config.origin, 0),
  );
  return response;
});
export const DELETE = handle(async (request, ctx) => {
  // writeGuard verifica POST; mantém o mesmo guard sem alterar a política global.
  writeGuard(
    new Request(request.url, { method: 'POST', headers: request.headers }),
    'x-sncr-action',
  );
  medical(ctx.role);
  await new SncrSessions(adminClient()).disconnect({
    clinicId: ctx.clinic,
    userId: ctx.user,
  });
  const response = json({ state: 'disconnected', remoteRevocation: false });
  for (const name of [AUTH_COOKIE, TRANSFER_COOKIE])
    response.headers.append(
      'Set-Cookie',
      authCookie(name, '', new URL(request.url).origin, 0),
    );
  return response;
});
