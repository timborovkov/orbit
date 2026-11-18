import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.AUTH_DISABLED !== undefined &&
    process.env.AUTH_DISABLED !== 'false'
  ) {
    const { env } = await import('@/lib/env');
    // Validate bypass configuration before serving even the public health route.
    try {
      env();
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Invalid AUTH_DISABLED configuration');
      // Next can keep its listener alive after a rejected instrumentation promise.
      // Exit explicitly so an unsafe configuration never leaves a serving process.
      process.exit(1);
    }
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('@/sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
