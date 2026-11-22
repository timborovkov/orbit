import { sql } from 'drizzle-orm';

import { db } from '@/lib/db';

/** Read a bounded conversation from the current run's own channel and account. */
export async function loadChannelThread(agentId: string, runId: string) {
  const messages = await db().execute<{ author: string | null; text: string }>(sql`
    SELECT coalesce(previous.author_name, previous.author_username) AS author, left(previous.text, 1_000) AS text
    FROM source_events current
    JOIN source_events previous ON previous.agent_id = current.agent_id
      AND previous.provider = current.provider
      AND previous.account_id IS NOT DISTINCT FROM current.account_id
      AND previous.thread_id = current.thread_id
    WHERE current.agent_id = ${agentId} AND current.run_id = ${runId}
      AND previous.id <> current.id AND previous.ingested_at <= current.ingested_at
      AND coalesce(previous.provider_created_at, previous.ingested_at)
        <= coalesce(current.provider_created_at, current.ingested_at)
    ORDER BY coalesce(previous.provider_created_at, previous.ingested_at) DESC, previous.id DESC
    LIMIT 6
  `);
  return messages.reverse();
}
