import { proposalTypes } from '@/lib/policy/scopes';
import type { ChannelAdapter } from '@/lib/runtime/channels/types';
import { X_DISCOVERY_POLL_JOB, X_PROVIDER } from '@/lib/runtime/x/types';

export const xChannel: ChannelAdapter = {
  id: X_PROVIDER,
  label: 'X',
  legacyOrigin: 'discovery',
  activity: {
    receivedLabel: 'X post',
    externalHref: (id) => (/^\d+$/.test(id) ? `https://x.com/i/web/status/${id}` : null),
  },
  run: { mode: 'evaluate', allowContentCapture: true, proposalTypes },
  async schedule(tx, agentId, config) {
    if (!config.xSearchQuery.trim()) return;
    const { ensureDiscoveryPollJob } = await import('@/lib/runtime/x/poll');
    await ensureDiscoveryPollJob(agentId, tx);
  },
  jobs() {
    return {
      [X_DISCOVERY_POLL_JOB]: async (job, signal) => {
        const [{ processDiscoveryPoll }, { createXSearchAdapter }, { resolveXBearerToken }] =
          await Promise.all([
            import('@/lib/runtime/x/poll'),
            import('@/lib/runtime/x/adapter'),
            import('@/lib/runtime/x/settings'),
          ]);
        const result = await processDiscoveryPoll(job, signal, {
          adapter: createXSearchAdapter(resolveXBearerToken()),
          jobId: job.id,
        });
        if (result.deferUntil) return { deferUntil: result.deferUntil };
      },
    };
  },
};
