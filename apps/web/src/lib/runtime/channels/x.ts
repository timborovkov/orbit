import type { ChannelAdapter } from '@/lib/runtime/channels/types';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import { X_DISCOVERY_POLL_JOB, X_PROVIDER } from '@/lib/runtime/x/types';

export const xChannel: ChannelAdapter = {
  id: X_PROVIDER,
  label: 'X',
  legacyOrigin: 'discovery',
  activity: {
    receivedLabel: 'X post',
    externalHref: (id) => (/^\d+$/.test(id) ? `https://x.com/i/web/status/${id}` : null),
  },
  run: { mode: 'evaluate', allowContentCapture: true, proposalTypes: [X_REPLY_ACTION] },
  actions: [
    {
      type: X_REPLY_ACTION,
      label: 'X reply',
      provider: 'x-api',
      alwaysRequiresApproval: false,
      reviewInShadow: true,
      requiresDispatchMarker: true,
      consentScope: X_REPLY_ACTION,
      async validateApproval(tx, intent) {
        const { validateXReplyApproval } = await import('@/lib/runtime/x/reply');
        return validateXReplyApproval(tx, intent);
      },
      async prepareDelivery(tx, outbound, intent) {
        const { prepareXReplyDelivery } = await import('@/lib/runtime/x/reply');
        return prepareXReplyDelivery(tx, outbound, intent);
      },
    },
  ],
  async schedule(tx, agentId, config) {
    const { discoveryQueries } = await import('@/lib/runtime/config');
    if (!discoveryQueries(config).length || config.xDiscoveryPaused) return;
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
