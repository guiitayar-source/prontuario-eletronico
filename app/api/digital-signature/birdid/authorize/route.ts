import { handle, HttpError, json } from '@/lib/supabase/server';
import { documentSigningService } from '@/lib/signature/document-signing-service';
import {
  configuredSignatureProviders,
  signatureRedirectUri,
} from '@/lib/signature/provider-factory';
import { isSignatureProviderId } from '@/lib/signature/providers';

export const dynamic = 'force-dynamic';

// O caminho mantém "birdid" porque é o endereço já cadastrado no Bird ID; serve aos dois PSCs
// (`?provider=vidaas`). O callback descobre o provedor pelo estado salvo no início.
export const GET = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role)) {
    throw new HttpError(
      403,
      'Apenas médicos podem autorizar assinaturas digitais.',
    );
  }

  const url = new URL(request.url);
  const provider =
    url.searchParams.get('provider') ||
    configuredSignatureProviders()[0] ||
    'birdid';
  if (!isSignatureProviderId(provider)) {
    throw new HttpError(400, 'Provedor de certificado em nuvem desconhecido.');
  }

  const redirectUri =
    signatureRedirectUri(provider) ||
    `${url.origin}/api/digital-signature/birdid/callback`;

  const result = await documentSigningService.initiateOAuthSession({
    db: ctx.db,
    clinicId: ctx.clinic,
    userId: ctx.user,
    redirectUri,
    provider,
  });

  return json(result);
});
