import type { sqlClient } from '@/lib/db';

/** Scope a query whose knowledge_documents row has the alias "document". */
export function knowledgeVisibleToAgent(client: ReturnType<typeof sqlClient>, agentId: string) {
  return client`(
    document.agent_id = ${agentId}
    OR EXISTS (
      SELECT 1 FROM knowledge_library_grants AS membership
      WHERE membership.library_id = document.library_id AND membership.agent_id = ${agentId}
    )
  )`;
}
