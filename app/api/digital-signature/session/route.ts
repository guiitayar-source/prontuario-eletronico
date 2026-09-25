import { handle, HttpError, json } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm acesso a sessões de assinatura.'
    );
  }

  const session = await documentSigningService.getActiveSession(
    ctx.db,
    ctx.clinic,
    ctx.user
  );

  return json({
    active: Boolean(session),
    session,
  });
});

export const DELETE = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm acesso a sessões de assinatura.'
    );
  }

  await documentSigningService.revokeSession(ctx.db, ctx.clinic, ctx.user);

  return json({ success: true });
});
