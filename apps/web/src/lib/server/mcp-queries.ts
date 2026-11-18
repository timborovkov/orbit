import 'server-only';

import { asc, count, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentMcpConnections, mcpConnections } from '@/lib/schema';

export async function listMcpConnections() {
  const email = await requireAdmin();
  const rows = await db()
    .select({
      id: mcpConnections.id,
      name: mcpConnections.name,
      url: mcpConnections.url,
      transport: mcpConnections.transport,
      toolAllowlist: mcpConnections.toolAllowlist,
      encryptedHeaders: mcpConnections.encryptedHeaders,
      actor: mcpConnections.actor,
      updatedAt: mcpConnections.updatedAt,
      agentCount: count(agentMcpConnections.agentId),
    })
    .from(mcpConnections)
    .leftJoin(agentMcpConnections, eq(agentMcpConnections.connectionId, mcpConnections.id))
    .groupBy(
      mcpConnections.id,
      mcpConnections.name,
      mcpConnections.url,
      mcpConnections.transport,
      mcpConnections.toolAllowlist,
      mcpConnections.encryptedHeaders,
      mcpConnections.actor,
      mcpConnections.updatedAt,
    )
    .orderBy(asc(mcpConnections.name));

  return {
    email,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      transport: row.transport,
      toolAllowlist: row.toolAllowlist,
      hasHeaders: Boolean(row.encryptedHeaders),
      updatedAt: row.updatedAt,
      actor: row.actor,
      agentCount: row.agentCount,
    })),
  };
}
