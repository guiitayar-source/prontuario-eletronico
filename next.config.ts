import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  outputFileTracingIncludes: { '/api/documents': ['./assets/fonts/*.ttf'] },
};

export default nextConfig;
