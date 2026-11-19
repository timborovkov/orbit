import { emailMessages, emailThreads, runs } from '@/lib/schema';
import { DEMO_ACTOR, DEMO_AGENTS, DEMO_CONFIGS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

const threadId = '00000000-0000-4000-a800-000000000001';
const messageId = '00000000-0000-4000-a800-000000000002';
const runId = '00000000-0000-4000-a800-000000000003';

export const emailModule: SeedModule = {
  name: 'email',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.sarah;
    const configurationId = DEMO_CONFIGS.sarahV2;
    const body = 'Where can I find my invoices?';
    await tx.insert(emailThreads).values({ id: threadId, agentId }).onConflictDoNothing();
    await tx
      .insert(runs)
      .values({
        id: runId,
        agentId,
        configurationId,
        actor: DEMO_ACTOR,
        origin: 'email',
        input: body,
        status: 'completed',
        expiresAt: now,
        finishedAt: now,
        result: {
          error: null,
          actions: [],
          steps: [
            {
              stage: 'main',
              model: 'demo/fixture',
              inputTokens: 0,
              outputTokens: 0,
              decision: {
                relevant: true,
                priority: 0.6,
                reason: 'Billing question',
                actions: [],
                answer: 'You can find your invoices under Billing in your workspace settings.',
                citations: [],
              },
            },
          ],
        },
      })
      .onConflictDoNothing();
    await tx
      .insert(emailMessages)
      .values({
        id: messageId,
        agentId,
        threadId,
        runId,
        configurationId,
        resendEmailId: messageId,
        event: { fixture: DEMO_ACTOR },
        sender: 'customer@example.test',
        subject: 'Invoice history',
        receivedAt: now,
        body,
        messageId: 'invoice-history@example.test',
      })
      .onConflictDoNothing();
  },
};
