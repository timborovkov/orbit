export { reportFailure } from '@/lib/observability/errors';
export {
  createRunTelemetry,
  ensureTelemetryContext,
  flushTelemetry,
  recordApprovalDecision,
  shutdownTelemetry,
} from '@/lib/observability/telemetry';
