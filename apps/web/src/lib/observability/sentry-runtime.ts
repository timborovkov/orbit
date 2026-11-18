import { observabilityEnvironment, parseObservabilityEnv } from '@/lib/observability/env';
import { sentryBeforeSend } from '@/lib/observability/errors';

export { registerErrorCapture } from '@/lib/observability/errors';

export function sentryInitOptions() {
  const config = parseObservabilityEnv(process.env);
  const dsn = config.sentryDsn;
  if (!dsn) return;
  return {
    dsn,
    environment: observabilityEnvironment(),
    tracesSampleRate: config.sentryTracesSampleRate,
    sendDefaultPii: false,
    beforeSend: sentryBeforeSend,
  };
}
