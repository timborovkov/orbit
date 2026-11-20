import { FIXTURE_X_POSTS } from '@/lib/runtime/x/fixture';
import { formatDiscoveryInput } from '@/lib/runtime/x/poll';
import { X_DISCOVERY_ACTOR, X_PROVIDER } from '@/lib/runtime/x/types';
import { discoveryCursors, runs, sourceEvents } from '@/lib/schema';
import { DEMO_AGENTS, DEMO_CONFIGS, DEMO_DISCOVERY_RUNS, DEMO_SOURCE_EVENTS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Fixture X discovery events and completed shadow evaluations for John.
 * Polling itself is not started by seed (no live X token required).
 */
export const discoveryModule: SeedModule = {
  name: 'discovery',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.john;
    const configurationId = DEMO_CONFIGS.johnV2;
    const posts = FIXTURE_X_POSTS.filter((post) => post.id === '1001' || post.id === '1002');

    await tx
      .insert(discoveryCursors)
      .values({
        agentId,
        provider: X_PROVIDER,
        sinceId: '1002',
        lastPolledAt: now,
        lastStatus: 'ok',
        lastError: null,
        updatedAt: now,
      })
      .onConflictDoNothing();

    for (const post of posts) {
      const runId =
        post.id === '1001' ? DEMO_DISCOVERY_RUNS.johnPost1001 : DEMO_DISCOVERY_RUNS.johnPost1002;
      const eventId =
        post.id === '1001' ? DEMO_SOURCE_EVENTS.johnPost1001 : DEMO_SOURCE_EVENTS.johnPost1002;
      const relevant = post.id !== '1003';
      await tx
        .insert(runs)
        .values({
          id: runId,
          agentId,
          configurationId,
          actor: X_DISCOVERY_ACTOR,
          origin: 'discovery',
          input: formatDiscoveryInput(post),
          status: 'completed',
          expiresAt: now,
          finishedAt: now,
          result: {
            error: null,
            steps: [
              {
                stage: 'evaluator',
                model: 'demo/fixture',
                inputTokens: 12,
                outputTokens: 40,
                decision: {
                  relevant,
                  priority: relevant ? 0.82 : 0.1,
                  reason: relevant
                    ? 'Prospect is asking about work-history tooling that matches John’s mission.'
                    : 'Unrelated noise; ignore.',
                  actions: relevant
                    ? [
                        {
                          type: 'reply',
                          reason: 'Offer a short, relevant intro to The Timeline.',
                          draft:
                            'If you want a clear picture of what changed and why across delivery work, The Timeline is built for that. Happy to walk through a short demo with a human.',
                        },
                      ]
                    : [],
                },
              },
            ],
            actions: relevant
              ? [
                  {
                    type: 'reply',
                    reason: 'Offer a short, relevant intro to The Timeline.',
                    draft:
                      'If you want a clear picture of what changed and why across delivery work, The Timeline is built for that. Happy to walk through a short demo with a human.',
                    policy: 'suppressed',
                    effect: 'Shadow mode suppresses external writes. Proposal logged only.',
                  },
                ]
              : [],
          },
        })
        .onConflictDoNothing();

      await tx
        .insert(sourceEvents)
        .values({
          id: eventId,
          agentId,
          provider: X_PROVIDER,
          providerEventId: post.id,
          payload: post.raw,
          text: post.text,
          authorId: post.authorId ?? null,
          authorUsername: post.authorUsername ?? null,
          providerCreatedAt: post.createdAt ? new Date(post.createdAt) : null,
          ingestedAt: now,
          runId,
        })
        .onConflictDoNothing();
    }
  },
};
