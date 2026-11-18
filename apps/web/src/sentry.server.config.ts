import * as Sentry from '@sentry/nextjs';

import { registerErrorCapture, sentryInitOptions } from '@/lib/observability/sentry-runtime';

const options = sentryInitOptions();
if (options) {
  Sentry.init(options);
  registerErrorCapture(({ message, error, tags }) => {
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      if (error) Sentry.captureException(error);
      else Sentry.captureMessage(message);
    });
  });
}
