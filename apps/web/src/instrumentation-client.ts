import * as Sentry from '@sentry/nextjs';

import { sentryBeforeSend } from '@/lib/observability/errors';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  const sample = Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  Sentry.init({
    dsn,
    tracesSampleRate: Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 0.1,
    beforeSend: sentryBeforeSend,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
