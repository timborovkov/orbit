'use server';

import { revalidatePath } from 'next/cache';
import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { listRemoteTools } from '@/lib/runtime/mcp';
import {
  deleteMcpConnection,
  mcpConnectionInput,
  persistAgentMcpConnections,
  persistMcpConnection,
} from '@/lib/server/mcp-mutations';
import { resolveMcpDiscoverHeaders } from '@/lib/server/mcp-queries';

const uuid = z.uuid();

function parseJsonField<T>(raw: FormDataEntryValue | null, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function saveMcpConnection(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = mcpConnectionInput.safeParse({
    name: form.get('name'),
    url: form.get('url'),
    transport: form.get('transport'),
    toolAllowlist: parseJsonField(form.get('toolAllowlist'), []),
    headers: parseJsonField(form.get('headers'), []),
  });
  if (!parsed.success) {
    return {
      error: 'Check the name, URL, transport, tools and header rows.',
    };
  }
  const connectionIdRaw = form.get('connectionId');
  const connectionId =
    typeof connectionIdRaw === 'string' && connectionIdRaw.trim() !== ''
      ? uuid.parse(connectionIdRaw)
      : undefined;
  const clearHeaders = form.get('clearHeaders') === 'true';
  const result = await persistMcpConnection(actor, parsed.data, connectionId, clearHeaders);
  if ('error' in result) return result;
  revalidatePath('/mcp');
  revalidatePath('/');
  return { message: connectionId ? 'Connection saved.' : 'Connection created.' };
}

export async function removeMcpConnection(form: FormData): Promise<void> {
  await checkOrigin();
  const actor = await requireAdmin();
  const connectionId = uuid.parse(form.get('connectionId'));
  await deleteMcpConnection(actor, connectionId);
  revalidatePath('/mcp');
  revalidatePath('/');
}

export async function saveAgentMcpConnections(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const connectionIds = form
    .getAll('connectionId')
    .flatMap((value) => (typeof value === 'string' && value ? [uuid.parse(value)] : []));
  const result = await persistAgentMcpConnections(actor, agentId, connectionIds);
  if ('error' in result) return result;
  revalidatePath(`/agents/${agentId}`);
  return {
    message: `Attached ${result.count} MCP connection${result.count === 1 ? '' : 's'}.`,
  };
}

const discoverInput = z.object({
  url: z.url().max(2000),
  transport: z.enum(['http', 'sse']),
  connectionId: uuid.optional(),
  clearHeaders: z.boolean().optional(),
  headers: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(120),
        value: z.string().max(2000),
      }),
    )
    .max(40)
    .optional(),
});

/** Probe a remote MCP server for tool names using draft or stored credentials. */
export async function discoverMcpTools(input: {
  url: string;
  transport: 'http' | 'sse';
  connectionId?: string;
  clearHeaders?: boolean;
  headers?: { key: string; value: string }[];
}): Promise<{ tools: string[] } | { error: string }> {
  await checkOrigin();
  await requireAdmin();
  const parsed = discoverInput.safeParse(input);
  if (!parsed.success) return { error: 'Provide a valid URL, transport and header rows.' };

  const headers = await resolveMcpDiscoverHeaders({
    connectionId: parsed.data.connectionId,
    clearHeaders: parsed.data.clearHeaders,
    draftHeaders: parsed.data.headers,
  });

  let client: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  try {
    client = await createMCPClient({
      transport: {
        type: parsed.data.transport,
        url: parsed.data.url,
        headers,
      },
      protocolVersionDiscovery: false,
    });
    const remote = await listRemoteTools(client);
    return { tools: Object.keys(remote).sort((a, b) => a.localeCompare(b)) };
  } catch {
    return {
      error: 'Could not fetch tools from that server. Check the URL, transport and headers.',
    };
  } finally {
    try {
      await client?.close();
    } catch {
      // Best-effort.
    }
  }
}
