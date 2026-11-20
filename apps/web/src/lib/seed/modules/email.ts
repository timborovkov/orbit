import {
  actionIntents,
  emailMailboxes,
  emailMessages,
  emailThreads,
  policyDecisions,
  runs,
} from '@/lib/schema';
import { DEMO_ACTOR, DEMO_AGENTS, DEMO_CONFIGS, DEMO_EMAIL } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const emailModule: SeedModule = {
  name: 'email',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.sarah;
    const configurationId = DEMO_CONFIGS.sarahV2;
    const body = 'Where can I find my invoices?';
    const draft = 'You can find your invoices under Billing in your workspace settings.';

    await tx
      .insert(emailMailboxes)
      .values({
        agentId,
        address: 'sarah@inbound.example.test',
        enabled: true,
      })
      .onConflictDoUpdate({
        target: emailMailboxes.agentId,
        set: { address: 'sarah@inbound.example.test', enabled: true },
      });

    await tx
      .insert(emailThreads)
      .values({ id: DEMO_EMAIL.threadId, agentId })
      .onConflictDoNothing();
    await tx
      .insert(runs)
      .values({
        id: DEMO_EMAIL.runId,
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
                answer: draft,
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
        id: DEMO_EMAIL.messageId,
        agentId,
        threadId: DEMO_EMAIL.threadId,
        runId: DEMO_EMAIL.runId,
        configurationId,
        resendEmailId: DEMO_EMAIL.messageId,
        event: { fixture: DEMO_ACTOR },
        sender: 'customer@example.test',
        subject: 'Invoice history',
        receivedAt: now,
        body,
        messageId: 'invoice-history@example.test',
      })
      .onConflictDoNothing();

    await tx
      .insert(actionIntents)
      .values({
        id: DEMO_EMAIL.intentId,
        agentId,
        runId: DEMO_EMAIL.runId,
        actionType: 'email.send',
        recipients: ['customer@example.test'],
        reviewStatus: 'pending',
        payload: {
          draft,
          reason: 'Inbound email reply draft',
          emailMessageId: DEMO_EMAIL.messageId,
          threadId: DEMO_EMAIL.threadId,
        },
        idempotencyKey: `email.send:${DEMO_EMAIL.messageId}`,
        decision: 'needs-approval',
        reasons: ['An administrator must review this proposal.'],
      })
      .onConflictDoNothing();
    await tx
      .insert(policyDecisions)
      .values({
        id: DEMO_EMAIL.policyId,
        agentId,
        runId: DEMO_EMAIL.runId,
        actionType: 'email.send',
        decision: 'needs-approval',
        reasons: ['An administrator must review this proposal.'],
        intentId: DEMO_EMAIL.intentId,
        actor: DEMO_ACTOR,
      })
      .onConflictDoNothing();
  },
};
