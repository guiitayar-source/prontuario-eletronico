import { handle, assertClinicalRole, json } from '@/lib/supabase/server';
import { configuredSignatureProviders } from '@/lib/signature/provider-factory';

export const dynamic = 'force-dynamic';

/** Provedores de certificado em nuvem com credenciais neste servidor (a tela só oferece estes). */
export const GET = handle(async (_request, ctx) => {
  assertClinicalRole(
    ctx.role,
    'Apenas médicos têm acesso a sessões de assinatura.',
  );
  return json({ providers: configuredSignatureProviders() });
});
