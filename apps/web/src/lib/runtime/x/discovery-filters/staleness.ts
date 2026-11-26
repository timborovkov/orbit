import { and, desc, eq } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import {
  evaluateDiscoveryFilters,
  formatFilterSkipReason,
  isPostPastMaxAge,
  postAgeExpiryAt,
} from '@/lib/runtime/x/discovery-filters/engine';
import { normalizeDiscoveryFilters } from '@/lib/runtime/x/discovery-filters/schema';
import { snapshotFromSourceEvent } from '@/lib/runtime/x/discovery-filters/snapshot';
import type { DiscoveryFilters } from '@/lib/runtime/x/discovery-filters/types';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import { X_PROVIDER } from '@/lib/runtime/x/types';
import { actionIntents, configurations, sourceEvents } from '@/lib/schema';

export const DISCOVERY_STALE_APPROVAL_REASON =
  'This reply can no longer be approved because the original post is older than the agent’s max post age.';

/** Load the discovery source event tied to a run. */
async function loadDiscoverySourceEvent(tx: Tx, agentId: string, runId: string) {
  return (
    await tx
      .select()
      .from(sourceEvents)
      .where(
        and(
          eq(sourceEvents.runId, runId),
          eq(sourceEvents.agentId, agentId),
          eq(sourceEvents.provider, X_PROVIDER),
        ),
      )
      .limit(1)
  ).at(0);
}

async function latestFilters(tx: Tx, agentId: string) {
  const version = (
    await tx
      .select({ config: configurations.config })
      .from(configurations)
      .where(eq(configurations.agentId, agentId))
      .orderBy(desc(configurations.version))
      .limit(1)
  ).at(0);
  return normalizeDiscoveryFilters(
    version && typeof version.config === 'object' && version.config
      ? (version.config as Record<string, unknown>).xDiscoveryFilters
      : undefined,
  );
}

/**
 * Re-check discovery filters (including max age) before approving an X reply.
 * Returns a human-readable refusal message when the post no longer qualifies.
 */
export async function discoveryApprovalBlockReason(
  tx: Tx,
  intent: { agentId: string; runId: string | null; actionType: string },
  now = new Date(),
): Promise<string | null> {
  if (intent.actionType !== X_REPLY_ACTION || !intent.runId) return null;
  const event = await loadDiscoverySourceEvent(tx, intent.agentId, intent.runId);
  if (!event) return 'X discovery post is unavailable.';

  const filters = await latestFilters(tx, intent.agentId);
  if (isPostPastMaxAge(event.providerCreatedAt, filters.maxPostAgeHours, now)) {
    return DISCOVERY_STALE_APPROVAL_REASON;
  }

  // Recently-engaged is a poll-time gate; the pending proposal itself is engagement.
  const approvalFilters: DiscoveryFilters = {
    ...filters,
    skipRecentlyEngagedAuthors: false,
  };
  const snapshot = snapshotFromSourceEvent(event);
  const decision = evaluateDiscoveryFilters(snapshot, approvalFilters, now);
  if (!decision.pass) {
    if (decision.reasons.some((reason) => /max age/i.test(reason))) {
      return DISCOVERY_STALE_APPROVAL_REASON;
    }
    return `This reply no longer passes discovery filters: ${formatFilterSkipReason(decision.reasons)}`;
  }
  return null;
}

/** Earliest review expiry for an X reply, combining admin expiry and post max age. */
export function discoveryReviewExpiresAt(
  postCreatedAt: Date | string | null | undefined,
  maxPostAgeHours: number,
  approvalExpiresAt: Date | null,
): Date | null {
  const ageExpiry = postAgeExpiryAt(postCreatedAt, maxPostAgeHours);
  if (!ageExpiry) return approvalExpiresAt;
  if (!approvalExpiresAt) return ageExpiry;
  return ageExpiry.getTime() < approvalExpiresAt.getTime() ? ageExpiry : approvalExpiresAt;
}

export type StaleDiscoveryIntent = {
  id: string;
  agentId: string;
  runId: string | null;
};

const STALE_SCAN_PAGE_SIZE = 200;
const STALE_SCAN_MAX_ROWS = 5000;

/**
 * Pending X reply intents whose source posts are past maxPostAge. Pages through
 * pending proposals so still-eligible rows cannot starve stale ones behind them.
 */
export async function listStaleDiscoveryApprovals(
  tx: Tx,
  limit = 100,
  now = new Date(),
): Promise<StaleDiscoveryIntent[]> {
  const stale: StaleDiscoveryIntent[] = [];
  const filtersByAgent = new Map<string, Promise<DiscoveryFilters>>();
  const filtersFor = (agentId: string) => {
    let cached = filtersByAgent.get(agentId);
    if (!cached) {
      cached = latestFilters(tx, agentId);
      filtersByAgent.set(agentId, cached);
    }
    return cached;
  };

  for (let offset = 0; offset < STALE_SCAN_MAX_ROWS && stale.length < limit;) {
    const page = await tx
      .select({
        id: actionIntents.id,
        agentId: actionIntents.agentId,
        runId: actionIntents.runId,
      })
      .from(actionIntents)
      .where(
        and(
          eq(actionIntents.reviewStatus, 'pending'),
          eq(actionIntents.actionType, X_REPLY_ACTION),
        ),
      )
      .orderBy(actionIntents.createdAt, actionIntents.id)
      .limit(STALE_SCAN_PAGE_SIZE)
      .offset(offset);
    if (!page.length) break;
    offset += page.length;

    const checks = await Promise.all(
      page.map(async (intent) => {
        if (!intent.runId) return null;
        const event = await loadDiscoverySourceEvent(tx, intent.agentId, intent.runId);
        if (!event) return null;
        const filters = await filtersFor(intent.agentId);
        return isPostPastMaxAge(event.providerCreatedAt, filters.maxPostAgeHours, now)
          ? intent
          : null;
      }),
    );
    for (const intent of checks) {
      if (intent && stale.length < limit) stale.push(intent);
    }
    if (page.length < STALE_SCAN_PAGE_SIZE) break;
  }
  return stale;
}
