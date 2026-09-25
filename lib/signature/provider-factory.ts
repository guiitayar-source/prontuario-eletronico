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

  if (process.env.BIRDID_USE_MOCK === 'true' || process.env.NODE_ENV === 'test') {
    return new MockBirdIdProvider();
  }

  if (process.env.BIRDID_USE_MOCK === 'false') {
    return new BirdIdProvider();
  }

  const hasCredentials = Boolean(
    process.env.BIRDID_CLIENT_ID?.trim() &&
    process.env.BIRDID_CLIENT_SECRET?.trim()
  );

  if (hasCredentials) {
    return new BirdIdProvider();
  }

  // Fallback para MockBirdIdProvider se credenciais da Valid não estiverem configuradas
  return new MockBirdIdProvider();
}
