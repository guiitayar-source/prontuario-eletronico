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

  const useMock =
    process.env.BIRDID_USE_MOCK === 'true' ||
    process.env.NODE_ENV === 'test' ||
    (!process.env.BIRDID_CLIENT_ID && process.env.NODE_ENV !== 'production');

  if (useMock) {
    return new MockBirdIdProvider();
  }

  return new BirdIdProvider();
}
