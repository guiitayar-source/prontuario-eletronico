import {
  handle,
  HttpError,
  json,
} from '@/lib/supabase/server';
import { evolutionSigningService } from '@/lib/signature/evolution-signing-service';

export const dynamic = 'force-dynamic';

export const GET = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm acesso aos detalhes de assinatura de evoluções.'
    );
  }

  const url = new URL(request.url);
  const evolutionId = url.searchParams.get('evolutionId');

  if (!evolutionId || !evolutionId.trim()) {
    throw new HttpError(400, 'Informe o ID da evolução.');
  }

  const verification = await evolutionSigningService.verifyEvolutionSignature({
    db: ctx.db,
    clinicId: ctx.clinic,
    evolutionId: evolutionId.trim(),
  });

  return json({ verification });
});
