import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: { serverActions: { bodySizeLimit: '6mb' } },
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  turbopack: { root: join(import.meta.dirname, '../..') },
};

export default nextConfig;
