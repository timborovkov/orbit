import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db';
import {
  mcpToolIsReadOnly,
  normalizeMcpAllowlist,
  type AgentMcpSelection,
  type McpAllowedTool,
} from '@/lib/mcp-allowlist';
import { mcpEndpointHeaderError, mcpHeadersFromRows, sameMcpEndpoint } from '@/lib/runtime/mcp';
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

export const mcpHeaderRow = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Use a valid header name.'),
  value: z.string().max(2000),
});

export const mcpEndpointInput = z.object({
  url: z
    .string()
    .max(2000)
    .pipe(z.url({ protocol: /^https?$/, normalize: true }))
    .refine((url) => {
      const parsed = new URL(url);
      return !parsed.username && !parsed.password && !parsed.hash;
    }),
  transport: z.enum(['http', 'sse']),
});

export const mcpSelectionInput = z.object({
  connectionId: z.uuid(),
  revision: z.iso.datetime(),
  toolNames: z.array(toolName).max(200),
});

export const mcpConnectionInput = z.object({
  name: skillSlug,
  ...mcpEndpointInput.shape,
  toolAllowlist: z
    .array(allowEntry)
    .max(200)
    .transform((tools) => normalizeMcpAllowlist(tools)),
  headers: z.array(mcpHeaderRow).max(40),
});

export type McpConnectionInput = z.infer<typeof mcpConnectionInput>;

export async function persistMcpConnection(
  actor: string,
  input: McpConnectionInput,
  connectionId?: string,
  clearHeaders = false,
) {
  return await db().transaction(async (tx) => {
    const headers = clearHeaders ? undefined : mcpHeadersFromRows(input.headers);
    if (connectionId) {
      const current = (
        await tx
          .select()
          .from(mcpConnections)
          .where(eq(mcpConnections.id, connectionId))
          .for('update')
      ).at(0);
      if (!current) return { error: 'Connection not found.' as const };
      const endpointChanged = !sameMcpEndpoint(current, input);
      if (endpointChanged && current.encryptedHeaders && !clearHeaders && !headers) {
        return { error: mcpEndpointHeaderError };
      }
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
      const retainedGrants = endpointChanged
        ? []
        : (input.toolAllowlist?.filter((tool) => tool.readOnly).map((tool) => sql`${tool.name}`) ??
          []);
      const retainedNames = sql`ARRAY[${sql.join(retainedGrants, sql`, `)}]::text[]`;
      // Remove grants when the endpoint changes or the tool loses its read-only classification.
      await tx
        .update(agentMcpConnections)
        .set({
          toolNames: sql`ARRAY(SELECT tool FROM unnest(${agentMcpConnections.toolNames}) AS granted(tool) WHERE tool = ANY(${retainedNames}))`,
        })
        .where(
          and(
            eq(agentMcpConnections.connectionId, connectionId),
            sql`NOT (${agentMcpConnections.toolNames} <@ ${retainedNames})`,
          ),
        );
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
  selections: (AgentMcpSelection & { revision: string })[],
) {
  const unique = new Map(selections.map((selection) => [selection.connectionId, selection]));
  return await db().transaction(async (tx) => {
    // Serialize concurrent attachment replaces so two empty→insert saves cannot union.
    const agent = (
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    if (unique.size) {
      const found = await tx
        .select({
          id: mcpConnections.id,
          allowlist: mcpConnections.toolAllowlist,
          updatedAt: mcpConnections.updatedAt,
        })
        .from(mcpConnections)
        .where(inArray(mcpConnections.id, [...unique.keys()]))
        .for('share');
      if (found.length !== unique.size)
        return { error: 'One or more MCP connections were not found.' };
      for (const connection of found) {
        const allowlist = normalizeMcpAllowlist(connection.allowlist);
        const selection = unique.get(connection.id);
        if (
          selection?.revision !== connection.updatedAt.toISOString() ||
          selection.toolNames.some((name) => !mcpToolIsReadOnly(allowlist, name))
        ) {
          return {
            error:
              'One or more MCP tools are no longer available as read-only. Refresh and try again.',
          };
        }
      }
    }
    await tx.delete(agentMcpConnections).where(eq(agentMcpConnections.agentId, agentId));
    if (unique.size) {
      await tx.insert(agentMcpConnections).values(
        [...unique.values()].map(({ connectionId, toolNames }) => ({
          agentId,
          connectionId,
          toolNames: [...new Set(toolNames)],
        })),
      );
    }
    await tx.insert(audit).values({
      actor,
      action: `Updated MCP attachments and tool grants for agent ${agentId} (${unique.size} connections)`,
    });
    return { count: unique.size };
  });
}
