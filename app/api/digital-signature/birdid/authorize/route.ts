import { handle, HttpError, json } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos podem autorizar assinaturas digitais.'
    );
  }

  const origin = new URL(request.url).origin;
  const redirectUri =
    process.env.BIRDID_REDIRECT_URI ||
    `${origin}/api/digital-signature/birdid/callback`;

  const result = await documentSigningService.initiateOAuthSession({
    db: ctx.db,
    clinicId: ctx.clinic,
    userId: ctx.user,
    redirectUri,
    provider: 'birdid',
  });

  return json(result);
});
