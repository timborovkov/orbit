'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { listRemoteTools, mcpDiscoverySignal, openMcpClient } from '@/lib/runtime/mcp';
import {
  deleteMcpConnection,
  mcpConnectionInput,
  mcpEndpointInput,
  mcpHeaderRow,
  mcpSelectionInput,
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

export async function saveMcpConnection(
  form: FormData,
): Promise<{ error?: string; message?: string }> {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = mcpConnectionInput.safeParse({
    name: form.get('name'),
    url: form.get('url'),
    transport: form.get('transport'),
    toolAllowlist: parseJsonField(form.get('toolAllowlist'), null),
    headers: parseJsonField(form.get('headers'), null),
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
  revalidatePath('/agents/[id]', 'page');
  revalidatePath('/');
  return { message: connectionId ? 'Connection saved.' : 'Connection created.' };
}

export async function removeMcpConnection(form: FormData): Promise<void> {
  await checkOrigin();
  const actor = await requireAdmin();
  const connectionId = uuid.parse(form.get('connectionId'));
  await deleteMcpConnection(actor, connectionId);
  revalidatePath('/mcp');
  revalidatePath('/agents/[id]', 'page');
  revalidatePath('/');
}

export async function saveAgentMcpConnections(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = uuid.parse(form.get('agentId'));
  const selections = z
    .array(mcpSelectionInput)
    .safeParse(parseJsonField(form.get('selections'), null));
  if (!selections.success) return { error: 'Check the selected connections and tools.' };
  const result = await persistAgentMcpConnections(actor, agentId, selections.data);
  if ('error' in result) return result;
  revalidatePath(`/agents/${agentId}`);
  return {
    message: `Attached ${result.count} MCP connection${result.count === 1 ? '' : 's'}.`,
  };
}

const discoverInput = z.object({
  ...mcpEndpointInput.shape,
  connectionId: uuid.optional(),
  clearHeaders: z.boolean().optional(),
  headers: z.array(mcpHeaderRow).max(40).optional(),
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

  let client: Awaited<ReturnType<typeof openMcpClient>> | undefined;
  try {
    const credentials = await resolveMcpDiscoverHeaders({
      ...parsed.data,
      draftHeaders: parsed.data.headers,
    });
    if ('error' in credentials) return credentials;
    const signal = mcpDiscoverySignal();
    client = await openMcpClient({ ...parsed.data, headers: credentials.headers }, signal);
    const remote = await listRemoteTools(client, signal);
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
