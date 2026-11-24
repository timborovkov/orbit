import type { Tx } from '@/lib/db';
import type { ConsentScope } from '@/lib/policy/scopes';
import type { JobRecord } from '@/lib/queue/types';
import type { AgentConfig } from '@/lib/runtime/config';
import type { CommitmentAnchor } from '@/lib/runtime/follow-ups/types';
import type { SimulationResult } from '@/lib/runtime/simulation';
import type { actionIntents, outboundActions, runs } from '@/lib/schema';

export type ChannelRunMode = 'draft' | 'evaluate';

type CompletedChannelRun = {
  agentId: string;
  runId: string;
  actor: string;
  result: SimulationResult;
};

type DeliveryOutcome =
  | { ok: true; id: string; raw: Record<string, unknown> }
  | { ok: false; retryable: boolean; error: string; raw?: Record<string, unknown> };

export type OutboundRow = typeof outboundActions.$inferSelect;
export type ActionIntent = typeof actionIntents.$inferSelect;
type PreparedDelivery = {
  recipients: string[];
  provider?: string;
  send: (signal: AbortSignal) => Promise<DeliveryOutcome>;
};

export interface ChannelAction {
  type: string;
  label?: string;
  provider: string;
  alwaysRequiresApproval: boolean;
  /** Keep editable proposals in Shadow for actions that can run automatically in Live. */
  reviewInShadow?: boolean;
  /** This provider does not support idempotency keys for writes. */
  requiresDispatchMarker?: boolean;
  consentScope?: ConsentScope;
  /** Existing channels may use an equivalent provider-specific agent grant. */
  usesProviderGrant?: boolean;
  /** Compatibility for already-queued jobs and their workers. */
  jobType?: string;
  legacyReferences?: (
    intent: ActionIntent,
  ) => Partial<Pick<OutboundRow, 'emailMessageId' | 'threadId'>>;
  validateApproval?: (tx: Tx, intent: ActionIntent) => Promise<string | undefined>;
  prepareDelivery: (
    tx: Tx,
    outbound: OutboundRow,
    intent: ActionIntent,
  ) => Promise<PreparedDelivery | { error: string }>;
}

export type ChannelJobHandler = (
  job: JobRecord,
  signal: AbortSignal,
) => Promise<{ deferUntil: Date } | void>;

export interface ChannelAdapter {
  id: string;
  label: string;
  /** Resolves rows created before the channel field was introduced. */
  legacyOrigin?: Extract<typeof runs.$inferSelect.origin, 'email' | 'discovery'>;
  activity?: {
    receivedLabel: string;
    sentLabel?: string;
    externalHref?: (externalId: string) => string | null;
  };
  run: {
    mode: ChannelRunMode;
    proposalTypes?: readonly string[];
    jobType?: string;
    allowContentCapture?: boolean;
    knowledgeQuery?: (input: string) => string;
    recallQuery?: (input: string) => string;
    evaluationInput?: (tx: Tx, agentId: string, sourceId: string) => Promise<string | null>;
    complete?: (input: CompletedChannelRun) => Promise<unknown>;
    recover?: (input: CompletedChannelRun) => Promise<unknown>;
  };
  /** Draft-capable channels can prepare a reviewable follow-up for a stored conversation. */
  followUp?: {
    actionType: string;
    prepare: (
      tx: Tx,
      anchor: CommitmentAnchor,
      commitment: { subject: string; note: string },
    ) => Promise<{
      input: string;
      recipients: string[];
      payload: Record<string, unknown>;
    } | null>;
  };
  actions?: readonly ChannelAction[];
  schedule?: (tx: Tx, agentId: string, config: AgentConfig) => Promise<unknown>;
  jobs?: (workerId: string) => Record<string, ChannelJobHandler>;
}
