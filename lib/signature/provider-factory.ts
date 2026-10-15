import { HttpError } from '@/lib/supabase/server';
import { PscProvider } from './psc-provider.ts';
import { MockBirdIdProvider } from './mock-birdid-provider.ts';
import {
  SIGNATURE_PROVIDER_IDS,
  SIGNATURE_PROVIDERS,
  isSignatureProviderId,
  type SignatureProviderId,
} from './providers.ts';
import type { DigitalSignatureProvider } from './types.ts';

let customProvider: DigitalSignatureProvider | null = null;

export function setCustomSignatureProvider(
  provider: DigitalSignatureProvider | null,
): void {
  customProvider = provider;
}

function credentials(id: SignatureProviderId) {
  const { envPrefix, defaultBaseUrl } = SIGNATURE_PROVIDERS[id];
  return {
    clientId: process.env[`${envPrefix}_CLIENT_ID`]?.trim() || '',
    clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`]?.trim() || '',
    baseUrl: process.env[`${envPrefix}_BASE_URL`]?.trim() || defaultBaseUrl,
    redirectUri: process.env[`${envPrefix}_REDIRECT_URI`]?.trim() || '',
  };
}

/** Provedores com credenciais neste servidor, na ordem de `SIGNATURE_PROVIDERS`. */
export function configuredSignatureProviders(): SignatureProviderId[] {
  return SIGNATURE_PROVIDER_IDS.filter((id) => {
    const { clientId, clientSecret } = credentials(id);
    return Boolean(clientId && clientSecret);
  });
}

/** Endereço de retorno registrado no provedor, se a variável `<PREFIXO>_REDIRECT_URI` existir. */
export function signatureRedirectUri(id: SignatureProviderId): string | null {
  return credentials(id).redirectUri || null;
}

/**
 * Cliente do provedor em que a sessão foi aberta. Sessões e estados guardam o provedor, então
 * uma assinatura sempre volta ao mesmo PSC que emitiu o token.
 */
export function getSignatureProvider(
  id: string = 'birdid',
): DigitalSignatureProvider {
  if (customProvider) {
    return customProvider;
  }

  // O MockBirdIdProvider nunca deve participar do runtime normal da aplicação.
  // Permitido estritamente em ambiente de testes unitários automatizados.
  if (
    process.env.SIGNATURE_PROVIDER === 'mock' &&
    process.env.NODE_ENV === 'test'
  ) {
    return new MockBirdIdProvider();
  }

  if (!isSignatureProviderId(id)) {
    throw new HttpError(
      500,
      `Provedor de assinatura digital desconhecido: ${id}`,
    );
  }

  const { label } = SIGNATURE_PROVIDERS[id];
  const { clientId, clientSecret, baseUrl } = credentials(id);
  if (!clientId || !clientSecret) {
    throw new HttpError(
      503,
      `A assinatura com ${label} ainda não está disponível neste servidor.`,
    );
  }

  return new PscProvider({ label, clientId, clientSecret, baseUrl });
}
