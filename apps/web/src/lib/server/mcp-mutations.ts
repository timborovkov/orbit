import 'server-only';

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db';
import { normalizeMcpAllowlist, type McpAllowedTool } from '@/lib/mcp-allowlist';
import { encryptSecret } from '@/lib/runtime/secrets';
import {
  agentMcpConnections,
  agents,
  audit,
  mcpConnections,
  type McpTransport,
} from '@/lib/schema';
import { skillSlug } from '@/lib/server/skills-mutations';

const toolName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/, 'Use a valid tool name.');

const allowEntry = z.union([
  toolName.transform((name): McpAllowedTool => ({ name, readOnly: false })),
  z.object({
    name: toolName,
    readOnly: z.boolean(),
  }),
]);

const headerRow = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Use a valid header name.'),
  value: z.string().max(2000),
});

export const mcpConnectionInput = z.object({
  name: skillSlug,
  url: z.url().max(2000),
  transport: z.enum(['http', 'sse']),
  toolAllowlist: z
    .array(allowEntry)
    .max(200)
    .transform((tools) => normalizeMcpAllowlist(tools)),
  headers: z.array(headerRow).max(40),
});

export type McpConnectionInput = z.infer<typeof mcpConnectionInput>;

function headersFromRows(rows: McpConnectionInput['headers']): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const value = row.value.trim();
    if (!value) continue;
    headers[row.key] = value;
  }
  return Object.keys(headers).length ? headers : null;
}

export async function persistMcpConnection(
  actor: string,
  input: McpConnectionInput,
  connectionId?: string,
  clearHeaders = false,
) {
  return await db().transaction(async (tx) => {
    const headers = clearHeaders ? null : headersFromRows(input.headers);
    if (connectionId) {
      const current = (
        await tx.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId))
      ).at(0);
      if (!current) return { error: 'Connection not found.' as const };
      let encryptedHeaders = current.encryptedHeaders;
      if (clearHeaders) encryptedHeaders = null;
      else if (headers) {
        try {
          encryptedHeaders = encryptSecret(connectionId, JSON.stringify(headers));
        } catch {
          return {
            error:
              'Set ORBIT_ENCRYPTION_KEY to a 64-character hex key before saving MCP headers.' as const,
          };
        }
      }
      try {
        await tx
          .update(mcpConnections)
          .set({
            name: input.name,
            url: input.url,
            transport: input.transport satisfies McpTransport,
            toolAllowlist: input.toolAllowlist,
            encryptedHeaders,
            actor,
            updatedAt: new Date(),
          })
          .where(eq(mcpConnections.id, connectionId));
      } catch {
        return { error: 'That connection name is already in use.' as const };
      }
      await tx.insert(audit).values({
        actor,
        action: `Updated MCP connection ${input.name}`,
      });
      return { id: connectionId };
    }

    const id = randomUUID();
    let encryptedHeaders: string | null = null;
    if (headers) {
      try {
        encryptedHeaders = encryptSecret(id, JSON.stringify(headers));
      } catch {
        return {
          error:
            'Set ORBIT_ENCRYPTION_KEY to a 64-character hex key before saving MCP headers.' as const,
        };
      }
    }
    try {
      await tx.insert(mcpConnections).values({
        id,
        name: input.name,
        url: input.url,
        transport: input.transport satisfies McpTransport,
        toolAllowlist: input.toolAllowlist,
        encryptedHeaders,
        actor,
      });
    } catch {
      return { error: 'That connection name is already in use.' as const };
    }
    await tx.insert(audit).values({ actor, action: `Created MCP connection ${input.name}` });
    return { id };
  });
}

export async function deleteMcpConnection(actor: string, connectionId: string) {
  return await db().transaction(async (tx) => {
    const row = (
      await tx
        .delete(mcpConnections)
        .where(eq(mcpConnections.id, connectionId))
        .returning({ name: mcpConnections.name })
    ).at(0);
    if (!row) return false;
    await tx.insert(audit).values({ actor, action: `Deleted MCP connection ${row.name}` });
    return true;
  });
}

export async function persistAgentMcpConnections(
  actor: string,
  agentId: string,
  connectionIds: string[],
) {
  const unique = [...new Set(connectionIds)];
  return await db().transaction(async (tx) => {
    // Serialize concurrent attachment replaces so two empty→insert saves cannot union.
    const agent = (
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    if (unique.length) {
      const found = await tx
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(inArray(mcpConnections.id, unique));
      if (found.length !== unique.length)
        return { error: 'One or more MCP connections were not found.' };
    }
    await tx.delete(agentMcpConnections).where(eq(agentMcpConnections.agentId, agentId));
    if (unique.length) {
      await tx
        .insert(agentMcpConnections)
        .values(unique.map((connectionId) => ({ agentId, connectionId })));
    }
    await tx.insert(audit).values({
      actor,
      action: `Updated MCP attachments for agent ${agentId} (${unique.length} selected)`,
    });
    return { count: unique.length };
  });
}
