import type { NextConfig } from 'next';

// Next 16 supports this runtime flag before its public type catches up.
const experimental = { useTypeScriptCli: false } as unknown as NonNullable<
  NextConfig['experimental']
>;

// Cabeçalhos para todas as respostas. O CSP só restringe o que não depende de nonce
// (enquadramento, <base>, plugins e envio de formulários); scripts e estilos ficam como estão.
// Câmera (captura pelo celular) e microfone (Anamnesator) só para o próprio site.
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  {
    key: 'Content-Security-Policy',
    value:
      "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  outputFileTracingIncludes: { '/api/documents': ['./assets/fonts/*.ttf'] },
  experimental,
  // `npm run build` runs `tsc --noEmit` first. Avoid Next's duplicate typecheck
  // worker, which loses compiler output under the managed Node runtime.
  typescript: { ignoreBuildErrors: true },
  // Não gerar AGENTS.md/CLAUDE.md automaticamente: o guia do projeto é mantido à mão.
  agentRules: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
