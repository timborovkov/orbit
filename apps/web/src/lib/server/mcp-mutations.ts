import 'server-only';

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db';
import { encryptSecret } from '@/lib/runtime/secrets';
import { agentMcpConnections, audit, mcpConnections, type McpTransport } from '@/lib/schema';
import { skillSlug } from '@/lib/server/skills-mutations';

const headerLine = z
  .string()
  .trim()
  .max(4000)
  .refine((value) => {
    if (!value) return true;
    return value.split('\n').every((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const idx = trimmed.indexOf(':');
      return idx > 0 && trimmed.slice(0, idx).trim().length > 0;
    });
  }, 'Use one Header: value pair per line.');

export const mcpConnectionInput = z.object({
  name: skillSlug,
  url: z.url().max(2000),
  transport: z.enum(['http', 'sse']),
  toolAllowlist: z
    .string()
    .trim()
    .max(4000)
    .transform((value) => {
      if (!value) return null;
      const tools = [
        ...new Set(
          value
            .split(/[\n,]/)
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ];
      return tools.length ? tools : null;
    }),
  headersText: headerLine,
});

function parseHeaders(text: string): Record<string, string> | null {
  if (!text.trim()) return null;
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) headers[key] = value;
  }
  return Object.keys(headers).length ? headers : null;
}

export async function persistMcpConnection(
  actor: string,
  input: z.infer<typeof mcpConnectionInput>,
  connectionId?: string,
  clearHeaders = false,
) {
  return await db().transaction(async (tx) => {
    const headers = clearHeaders ? null : parseHeaders(input.headersText);
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
