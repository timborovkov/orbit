import 'server-only';

import { asc, count, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { normalizeMcpAllowlist } from '@/lib/mcp-allowlist';
import { decodeMcpHeaders, selectMcpDiscoverHeaders } from '@/lib/runtime/mcp';
import { agentMcpConnections, mcpConnections } from '@/lib/schema';

/**
 * Headers for admin Fetch tools: draft rows win; otherwise reuse stored ciphertext
 * for an existing connection (never returned to the browser).
 */
export async function resolveMcpDiscoverHeaders(input: {
  connectionId?: string;
  clearHeaders?: boolean;
  draftHeaders?: { key: string; value: string }[];
}): Promise<Record<string, string> | undefined> {
  let storedHeaders: Record<string, string> | undefined;
  if (input.connectionId && !input.clearHeaders) {
    const row = (
      await db()
        .select({
          id: mcpConnections.id,
          encryptedHeaders: mcpConnections.encryptedHeaders,
        })
        .from(mcpConnections)
        .where(eq(mcpConnections.id, input.connectionId))
    ).at(0);
    if (row) storedHeaders = decodeMcpHeaders(row.id, row.encryptedHeaders);
  }
  return selectMcpDiscoverHeaders({
    draftHeaders: input.draftHeaders,
    clearHeaders: input.clearHeaders,
    storedHeaders,
  });
}

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
      toolAllowlist: normalizeMcpAllowlist(row.toolAllowlist),
      hasHeaders: Boolean(row.encryptedHeaders),
      updatedAt: row.updatedAt,
      actor: row.actor,
      agentCount: row.agentCount,
    })),
  };
}
