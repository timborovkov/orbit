import { join } from 'node:path';

import type { NextConfig } from 'next';

import { withSentryConfig } from '@sentry/nextjs/config';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep screenshots and review captures free of the Next.js corner badge.
  devIndicators: false,
  // 10 MB knowledge + multipart overhead for knowledge uploads through Server Actions.
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  turbopack: { root: join(import.meta.dirname, '../..') },
  serverExternalPackages: [
    '@langfuse/client',
    '@langfuse/otel',
    '@langfuse/tracing',
    '@langfuse/vercel-ai-sdk',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/exporter-trace-otlp-http',
  ],
};

const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  sourcemaps: { disable: uploadSourceMaps ? false : true },
  widenClientFileUpload: false,
  errorHandler() {
    // Source map upload is optional; a missing token or Sentry outage must not fail the build.
  },
});
