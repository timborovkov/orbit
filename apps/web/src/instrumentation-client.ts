import * as Sentry from '@sentry/nextjs';

import { resolveTracesSampleRate } from '@/lib/observability/env';
import { sentryBeforeSend } from '@/lib/observability/errors';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    // Docker/Compose may bake an empty ARG; blank must not become Number('') === 0.
    tracesSampleRate: resolveTracesSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
    beforeSend: sentryBeforeSend,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
