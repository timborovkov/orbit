import 'server-only';

import { asc, count, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { normalizeMcpAllowlist } from '@/lib/mcp-allowlist';
import {
  decodeMcpHeaders,
  mcpEndpointHeaderError,
  mcpHeadersFromRows,
  sameMcpEndpoint,
} from '@/lib/runtime/mcp';
import { agentMcpConnections, mcpConnections, type McpTransport } from '@/lib/schema';

/**
 * Headers for admin Fetch tools: draft rows win; otherwise reuse stored ciphertext
 * for an existing connection (never returned to the browser).
 */
export async function resolveMcpDiscoverHeaders(input: {
  url: string;
  transport: McpTransport;
  connectionId?: string;
  clearHeaders?: boolean;
  draftHeaders?: { key: string; value: string }[];
}): Promise<{ headers?: Record<string, string> } | { error: string }> {
  if (input.clearHeaders) return {};
  const headers = mcpHeadersFromRows(input.draftHeaders ?? []);
  if (headers || !input.connectionId) return { headers };

  const row = (
    await db()
      .select({
        id: mcpConnections.id,
        url: mcpConnections.url,
        transport: mcpConnections.transport,
        encryptedHeaders: mcpConnections.encryptedHeaders,
      })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, input.connectionId))
  ).at(0);
  if (!row) return { error: 'Connection not found.' };
  if (!row.encryptedHeaders) return {};
  if (!sameMcpEndpoint(row, input)) return { error: mcpEndpointHeaderError };
  const storedHeaders = decodeMcpHeaders(row.id, row.encryptedHeaders);
  return storedHeaders
    ? { headers: storedHeaders }
    : { error: 'Stored MCP headers are unavailable. Replace or clear them.' };
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
