import { HttpError } from '@/lib/supabase/server';
import { BirdIdProvider } from './birdid-provider.ts';
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
    const missing: string[] = [];
    if (!process.env.BIRDID_CLIENT_ID?.trim()) missing.push('BIRDID_CLIENT_ID');
    if (!process.env.BIRDID_CLIENT_SECRET?.trim()) missing.push('BIRDID_CLIENT_SECRET');
    if (!process.env.BIRDID_REDIRECT_URI?.trim()) missing.push('BIRDID_REDIRECT_URI');

    if (missing.length > 0) {
      throw new HttpError(
        500,
        `Integração Bird ID não configurada. ${missing.join(', ')} ausente(s).`
      );
    }

    return new BirdIdProvider();
  }

  throw new HttpError(
    500,
    `Provedor de assinatura digital desconhecido: ${providerType}`
  );
}
