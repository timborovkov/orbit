import type { Tx } from '@/lib/db';
import { emailChannel } from '@/lib/runtime/channels/email';
import type { ChannelAdapter, ChannelJobHandler } from '@/lib/runtime/channels/types';
import { xChannel } from '@/lib/runtime/channels/x';
import type { AgentConfig } from '@/lib/runtime/config';
import { CHANNEL_OUTBOUND_JOB } from '@/lib/runtime/outbound/types';

const channels = new Map<string, ChannelAdapter>();
const reservedChannelIds = new Set(['channel', 'commitments', 'discovery', 'playground', 'replay']);

export function registerChannel(adapter: ChannelAdapter) {
  if (
    !/^[a-z][a-z0-9_-]{0,39}$/.test(adapter.id) ||
    channels.has(adapter.id) ||
    reservedChannelIds.has(adapter.id)
  ) {
    throw new Error('Channel must have a unique identifier.');
  }
  const actionIds = adapter.actions?.map(({ type }) => type) ?? [];
  if (
    new Set(actionIds).size !== actionIds.length ||
    actionIds.some(
      (type) =>
        !type.startsWith(`${adapter.id}.`) ||
        !/^[a-z][a-z0-9._-]{1,79}$/.test(type) ||
        channelAction(type),
    )
  ) {
    throw new Error('Channel actions must have unique, channel-qualified identifiers.');
  }
  if (
    adapter.followUp &&
    (adapter.run.mode !== 'draft' ||
      !adapter.actions?.some(
        (action) => action.type === adapter.followUp?.actionType && action.alwaysRequiresApproval,
      ))
  ) {
    throw new Error('Channel follow-ups require a draft profile and an approval-required action.');
  }
  channels.set(adapter.id, adapter);
  return () => {
    channels.delete(adapter.id);
  };
}

registerChannel(emailChannel);
registerChannel(xChannel);

export function channelAdapter(id: string | null | undefined) {
  return id ? channels.get(id) : undefined;
}

export function channelLabel(id: string) {
  return channelAdapter(id)?.label ?? id;
}

export function channelForRun(run: { origin: string; channel?: string | null }) {
  if (run.channel) return channelAdapter(run.channel);
  return [...channels.values()].find((adapter) => adapter.legacyOrigin === run.origin);
}

export function channelAction(type: string) {
  return [...channels.values()]
    .flatMap((adapter) =>
      (adapter.actions ?? []).map((action) => ({ channel: adapter.id, action })),
    )
    .find(({ action }) => action.type === type);
}

export function channelGrantOptions() {
  return [...channels.values()].flatMap((adapter) =>
    (adapter.actions ?? [])
      .filter((action) => !action.usesProviderGrant)
      .map((action) => ({
        type: action.type,
        label: action.label ?? `${adapter.label} · ${action.type.slice(adapter.id.length + 1)}`,
        alwaysRequiresApproval: action.alwaysRequiresApproval,
      })),
  );
}

export function channelRunJobTypes(defaultType: string) {
  return [
    defaultType,
    ...new Set([...channels.values()].flatMap(({ run }) => (run.jobType ? [run.jobType] : []))),
  ];
}

export function channelOutboundJobTypes() {
  return [
    CHANNEL_OUTBOUND_JOB,
    ...new Set(
      [...channels.values()].flatMap(({ actions }) =>
        (actions ?? []).flatMap(({ jobType }) => (jobType ? [jobType] : [])),
      ),
    ),
  ];
}

export function channelJobs(workerId: string, reservedTypes: string[]) {
  const seen = new Set(reservedTypes);
  const handlers = new Map<string, ChannelJobHandler>();
  for (const adapter of channels.values()) {
    for (const [type, handler] of Object.entries(adapter.jobs?.(workerId) ?? {})) {
      if (seen.has(type)) throw new Error(`Duplicate worker job type ${type}.`);
      seen.add(type);
      handlers.set(type, handler);
    }
  }
  return Object.fromEntries(handlers);
}

export async function scheduleChannelWork(tx: Tx, agentId: string, config: AgentConfig) {
  await Promise.all(
    [...channels.values()].flatMap(({ schedule }) =>
      schedule ? [schedule(tx, agentId, config)] : [],
    ),
  );
}
