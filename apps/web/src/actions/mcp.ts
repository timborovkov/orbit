'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import {
  deleteMcpConnection,
  mcpConnectionInput,
  persistAgentMcpConnections,
  persistMcpConnection,
} from '@/lib/server/mcp-mutations';

const uuid = z.uuid();

export async function saveMcpConnection(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = mcpConnectionInput.safeParse({
    name: form.get('name'),
    url: form.get('url'),
    transport: form.get('transport'),
    toolAllowlist: form.get('toolAllowlist') ?? '',
    headersText: form.get('headersText') ?? '',
  });
  if (!parsed.success) {
    return {
      error: 'Check the name, URL, transport, allowlist and header lines.',
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
