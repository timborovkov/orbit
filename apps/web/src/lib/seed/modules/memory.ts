import { agentMemories, emailMessages, emailThreads, runs } from '@/lib/schema';
import { DEMO_ACTOR, DEMO_AGENTS, DEMO_CONFIGS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

const entryId = '00000000-0000-4000-ae00-000000000001';
const runId = '00000000-0000-4000-ae00-000000000002';
const threadId = '00000000-0000-4000-ae00-000000000003';
const messageId = '00000000-0000-4000-ae00-000000000004';
const quote = 'Northstar requires SSO before we can start the pilot.';

export const memoryModule: SeedModule = {
  name: 'memory',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.sarah;
    const configurationId = DEMO_CONFIGS.sarahV2;
    const sourceAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const subject = 'Northstar pilot requirements';
    const sender = 'it@northstar.example.test';
    await tx.insert(emailThreads).values({ id: threadId, agentId }).onConflictDoNothing();
    await tx
      .insert(runs)
      .values({
        id: runId,
        agentId,
        configurationId,
        actor: DEMO_ACTOR,
        origin: 'email',
        input: JSON.stringify({
          currentMessage: { subject, sender, body: quote },
          previousMessages: [],
        }),
        status: 'completed',
        createdAt: sourceAt,
        expiresAt: sourceAt,
        finishedAt: sourceAt,
        result: { error: null, steps: [], actions: [] },
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
        sender,
        subject,
        body: quote,
        receivedAt: sourceAt,
      })
      .onConflictDoNothing();
    await tx
      .insert(agentMemories)
      .values({
        id: entryId,
        agentId,
        subjectKind: 'company',
        subject: 'Northstar',
        topic: 'SSO requirement',
        identityKey: JSON.stringify(['northstar', 'sso requirement']),
        fact: 'Northstar requires SSO before starting its pilot.',
        quote,
        runId,
        sourceKind: 'email',
        sourceId: messageId,
        sourceAt,
        learnedAt: sourceAt,
      })
      .onConflictDoNothing();
  },
};
