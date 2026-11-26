import { FIXTURE_X_POSTS, FIXTURE_X_REPLY_POST } from '@/lib/runtime/x/fixture';
import { formatDiscoveryInput } from '@/lib/runtime/x/poll';
import { X_REPLY_ACTION, xReplyKey } from '@/lib/runtime/x/reply-input';
import { X_DISCOVERY_ACTOR, X_PROVIDER } from '@/lib/runtime/x/types';
import {
  actionIntents,
  discoveryCursors,
  recipientConsents,
  runs,
  sourceEvents,
} from '@/lib/schema';
import {
  DEMO_ACTOR,
  DEMO_AGENTS,
  DEMO_CONFIGS,
  DEMO_DISCOVERY_RUNS,
  DEMO_INTENTS,
  DEMO_SOURCE_EVENTS,
} from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Fixture X discovery events and an editable reply proposal for John.
 * Polling itself is not started by seed (no live X token required).
 */
export const discoveryModule: SeedModule = {
  name: 'discovery',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.john;
    const configurationId = DEMO_CONFIGS.johnV2;
    const posts = [FIXTURE_X_REPLY_POST, ...FIXTURE_X_POSTS.filter((post) => post.id === '1002')];

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
      const invited = post.id === '1001';
      const runId = invited ? DEMO_DISCOVERY_RUNS.johnPost1001 : DEMO_DISCOVERY_RUNS.johnPost1002;
      const eventId = invited ? DEMO_SOURCE_EVENTS.johnPost1001 : DEMO_SOURCE_EVENTS.johnPost1002;
      const reply = {
        type: X_REPLY_ACTION,
        reason: 'Explain how The Timeline records delivery changes.',
        draft:
          'The Timeline shows what changed and why across delivery work. I can walk you through an example.',
      };
      await tx
        .insert(runs)
        .values({
          id: runId,
          agentId,
          configurationId,
          actor: X_DISCOVERY_ACTOR,
          origin: 'discovery',
          channel: X_PROVIDER,
          input: formatDiscoveryInput(post),
          status: invited ? 'awaiting_approval' : 'completed',
          expiresAt: now,
          finishedAt: invited ? null : now,
          result: {
            error: null,
            steps: [
              {
                stage: 'evaluator',
                model: 'demo/fixture',
                inputTokens: 12,
                outputTokens: 40,
                decision: {
                  relevant: true,
                  priority: 0.82,
                  reason: 'The author is asking about work-history tooling.',
                  actions: invited ? [{ ...reply, draft: null }] : [],
                },
              },
              ...(invited
                ? [
                    {
                      stage: 'main' as const,
                      model: 'demo/fixture',
                      inputTokens: 20,
                      outputTokens: 30,
                      decision: {
                        relevant: true,
                        priority: 0.82,
                        reason: 'The author explicitly asked John for a response.',
                        actions: [reply],
                      },
                    },
                  ]
                : []),
            ],
            actions: invited
              ? [
                  {
                    ...reply,
                    intentId: DEMO_INTENTS.johnXReply,
                    policy: 'needs-approval',
                    effect: 'An administrator must review this proposal.',
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
          providerCreatedAt: new Date(now.getTime() - (invited ? 5 : 20) * 60_000),
          ingestedAt: now,
          runId,
        })
        .onConflictDoNothing();

      if (invited && post.authorId) {
        const recipient = `x:${post.authorId}`;
        await tx
          .insert(recipientConsents)
          .values({
            agentId,
            recipient,
            scope: X_REPLY_ACTION,
            granted: true,
            actor: DEMO_ACTOR,
            evidence: 'The fixture author requests a response in post 1001.',
          })
          .onConflictDoNothing();
        await tx
          .insert(actionIntents)
          .values({
            id: DEMO_INTENTS.johnXReply,
            agentId,
            runId,
            actionType: X_REPLY_ACTION,
            recipients: [recipient],
            payload: { draft: reply.draft, reason: reply.reason },
            idempotencyKey: xReplyKey(agentId, post.id),
            reviewStatus: 'pending',
            decision: 'needs-approval',
            reasons: ['An administrator must review this proposal.'],
            createdAt: now,
          })
          .onConflictDoNothing();
      }
    }
  },
};
