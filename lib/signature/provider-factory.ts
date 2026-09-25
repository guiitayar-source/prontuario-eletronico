import { HttpError } from '@/lib/supabase/server';
import {
  BirdIdProvider,
  DEFAULT_BIRDID_BASE_URL,
  DEFAULT_BIRDID_CLIENT_ID,
  DEFAULT_BIRDID_CLIENT_SECRET,
} from './birdid-provider.ts';
import { MockBirdIdProvider } from './mock-birdid-provider.ts';
import type { DigitalSignatureProvider } from './types.ts';

let customProvider: DigitalSignatureProvider | null = null;

export function setCustomSignatureProvider(
  provider: DigitalSignatureProvider | null
): void {
  customProvider = provider;
}

export function getSignatureProvider(): DigitalSignatureProvider {
  if (customProvider) {
    return customProvider;
  }

  const providerType = process.env.SIGNATURE_PROVIDER || 'birdid';

  // O MockBirdIdProvider nunca deve participar do runtime normal da aplicação.
  // Permitido estritamente em ambiente de testes unitários automatizados.
  if (providerType === 'mock' && process.env.NODE_ENV === 'test') {
    return new MockBirdIdProvider();
  }

  if (providerType === 'birdid') {
    const clientId =
      process.env.BIRDID_CLIENT_ID?.trim() || DEFAULT_BIRDID_CLIENT_ID;
    const clientSecret =
      process.env.BIRDID_CLIENT_SECRET?.trim() || DEFAULT_BIRDID_CLIENT_SECRET;
    const baseUrl =
      process.env.BIRDID_BASE_URL?.trim() || DEFAULT_BIRDID_BASE_URL;

    if (!clientId || !clientSecret) {
      throw new HttpError(
        500,
        'Integração Bird ID não configurada. BIRDID_CLIENT_ID ou BIRDID_CLIENT_SECRET ausente.'
      );
    }

    return new BirdIdProvider({
      clientId,
      clientSecret,
      baseUrl,
    });
  }

  throw new HttpError(
    500,
    `Provedor de assinatura digital desconhecido: ${providerType}`
  );
}
