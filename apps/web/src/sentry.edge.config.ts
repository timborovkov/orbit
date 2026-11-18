import * as Sentry from '@sentry/nextjs';

import { sentryInitOptions } from '@/lib/observability/sentry-runtime';

const options = sentryInitOptions();
if (options) Sentry.init(options);
