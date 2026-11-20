import { evaluationCases, evaluationComparisons, runs } from '@/lib/schema';
import {
  DEMO_ACTOR,
  DEMO_AGENTS,
  DEMO_CONFIGS,
  DEMO_EMAIL,
  DEMO_EVAL_CASES,
  DEMO_EVAL_COMPARISONS,
  DEMO_EVAL_REPLAY_RUNS,
  DEMO_RUNS,
} from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

/** Matches `buildEmailDraftInput` so Sarah's knowledge.search replay path can JSON.parse. */
export const DEMO_SARAH_EMAIL_CASE_INPUT = JSON.stringify({
  currentMessage: {
    subject: 'Invoice history',
    body: 'Where can I find my invoices?',
    sender: 'customer@example.test',
  },
  previousMessages: [],
});

export const evaluationsModule: SeedModule = {
  name: 'evaluations',
  async apply({ tx, now }) {
    await tx
      .insert(evaluationCases)
      .values([
        {
          id: DEMO_EVAL_CASES.johnPlayground,
          agentId: DEMO_AGENTS.john,
          title: 'Demo: inbound lead post',
          sourceKind: 'playground',
          sourceRunId: DEMO_RUNS.johnSucceeded,
          input:
            'Looking for a CRM that helps founders follow up without sounding robotic. Any recommendations?',
          recipients: [],
          actor: DEMO_ACTOR,
          createdAt: now,
        },
        {
          id: DEMO_EVAL_CASES.sarahEmail,
          agentId: DEMO_AGENTS.sarah,
          title: 'Demo: invoice email',
          sourceKind: 'email',
          sourceEmailMessageId: DEMO_EMAIL.messageId,
          input: DEMO_SARAH_EMAIL_CASE_INPUT,
          recipients: [],
          actor: DEMO_ACTOR,
          createdAt: now,
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(runs)
      .values([
        {
          id: DEMO_EVAL_REPLAY_RUNS.johnLeft,
          agentId: DEMO_AGENTS.john,
          configurationId: DEMO_CONFIGS.johnV1,
          origin: 'replay',
          input:
            'Looking for a CRM that helps founders follow up without sounding robotic. Any recommendations?',
          status: 'completed',
          actor: DEMO_ACTOR,
          expiresAt: now,
          finishedAt: now,
          result: {
            error: null,
            actions: [
              {
                type: 'reply',
                draft: 'Happy to share how Orbit helps founders stay personal at scale.',
                reason: 'Relevant sales opportunity',
                policy: 'suppressed',
                effect: 'Replay execution suppresses all external writes.',
              },
            ],
            steps: [
              {
                stage: 'main',
                model: 'demo/fixture',
                inputTokens: 12,
                outputTokens: 24,
                decision: {
                  relevant: true,
                  priority: 0.8,
                  reason: 'Sales-relevant inbound',
                  actions: [{ type: 'reply', reason: 'Offer help', draft: '…' }],
                },
              },
            ],
          },
        },
        {
          id: DEMO_EVAL_REPLAY_RUNS.johnRight,
          agentId: DEMO_AGENTS.john,
          configurationId: DEMO_CONFIGS.johnV2,
          origin: 'replay',
          input:
            'Looking for a CRM that helps founders follow up without sounding robotic. Any recommendations?',
          status: 'completed',
          actor: DEMO_ACTOR,
          expiresAt: now,
          finishedAt: now,
          result: {
            error: null,
            actions: [
              {
                type: 'reply',
                draft: 'Orbit keeps follow-ups human — I can walk you through a short demo.',
                reason: 'Stronger CTA in v2',
                policy: 'suppressed',
                effect: 'Replay execution suppresses all external writes.',
              },
            ],
            steps: [
              {
                stage: 'main',
                model: 'demo/fixture',
                inputTokens: 12,
                outputTokens: 28,
                decision: {
                  relevant: true,
                  priority: 0.85,
                  reason: 'Sales-relevant inbound',
                  actions: [{ type: 'reply', reason: 'Offer demo', draft: '…' }],
                },
              },
            ],
          },
        },
      ])
      .onConflictDoNothing();

    await tx
      .insert(evaluationComparisons)
      .values({
        id: DEMO_EVAL_COMPARISONS.johnVersions,
        agentId: DEMO_AGENTS.john,
        caseId: DEMO_EVAL_CASES.johnPlayground,
        leftConfigurationId: DEMO_CONFIGS.johnV1,
        rightConfigurationId: DEMO_CONFIGS.johnV2,
        leftRunId: DEMO_EVAL_REPLAY_RUNS.johnLeft,
        rightRunId: DEMO_EVAL_REPLAY_RUNS.johnRight,
        status: 'completed',
        actor: DEMO_ACTOR,
        createdAt: now,
        finishedAt: now,
      })
      .onConflictDoNothing();
  },
};
