import { and, eq, gte } from 'drizzle-orm';

import type { Tx } from '@/lib/db';
import { actionIntents } from '@/lib/schema';

/**
 * Author provider IDs this agent already engaged (any action intent targeting them)
 * within the lookback window. Uses recipient form `x:{authorId}`.
 */
export async function loadRecentlyEngagedAuthorIds(
  tx: Tx,
  agentId: string,
  authorIds: string[],
  withinHours: number,
  now = new Date(),
): Promise<Set<string>> {
  const wanted = new Set(authorIds.filter(Boolean));
  if (!wanted.size) return new Set();

  const since = new Date(now.getTime() - Math.max(1, withinHours) * 60 * 60 * 1000);
  const rows = await tx
    .select({ recipients: actionIntents.recipients })
    .from(actionIntents)
    .where(and(eq(actionIntents.agentId, agentId), gte(actionIntents.createdAt, since)))
    .limit(2000);

  const engaged = new Set<string>();
  for (const row of rows) {
    for (const recipient of row.recipients) {
      if (typeof recipient !== 'string' || !recipient.startsWith('x:')) continue;
      const authorId = recipient.slice(2);
      if (wanted.has(authorId)) engaged.add(authorId);
    }
  }
  return engaged;
}
