import type { NextConfig } from 'next';

// Next 16 supports this runtime flag before its public type catches up.
const experimental = { useTypeScriptCli: false } as unknown as NonNullable<
  NextConfig['experimental']
>;

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  outputFileTracingIncludes: { '/api/documents': ['./assets/fonts/*.ttf'] },
  experimental,
  // `npm run build` runs `tsc --noEmit` first. Avoid Next's duplicate typecheck
  // worker, which loses compiler output under the managed Node runtime.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
