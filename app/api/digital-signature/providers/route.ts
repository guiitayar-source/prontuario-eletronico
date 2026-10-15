import { handle, HttpError, json } from '@/lib/supabase/server';
import { configuredSignatureProviders } from '@/lib/signature/provider-factory';

export const dynamic = 'force-dynamic';

/** Provedores de certificado em nuvem com credenciais neste servidor (a tela só oferece estes). */
export const GET = handle(async (_request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos têm acesso a sessões de assinatura.',
    );
  }
  return json({ providers: configuredSignatureProviders() });
});
