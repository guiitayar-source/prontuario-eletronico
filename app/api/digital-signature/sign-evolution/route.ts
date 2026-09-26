import {
  handle,
  HttpError,
  json,
  writeGuard,
  body,
} from '@/lib/supabase/server';
import { evolutionSigningService } from '@/lib/signature/evolution-signing-service';

export const dynamic = 'force-dynamic';

export const POST = handle(async (request, ctx) => {
  writeGuard(request, 'x-signature-action');

  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos podem assinar evoluções clínicas.'
    );
  }

  const payload = await body(request);
  const evolutionId = payload.evolutionId;

  if (typeof evolutionId !== 'string' || !evolutionId.trim()) {
    throw new HttpError(400, 'Informe o ID da evolução a ser assinada.');
  }

  const result = await evolutionSigningService.signEvolution({
    db: ctx.db,
    clinicId: ctx.clinic,
    userId: ctx.user,
    evolutionId: evolutionId.trim(),
  });

  return json(result);
});
