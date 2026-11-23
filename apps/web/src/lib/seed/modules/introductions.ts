import { observedProfiles } from '@/lib/runtime/introductions/profiles';
import { PEOPLE_INTRODUCE } from '@/lib/runtime/introductions/types';
import { actionIntents, introductionProposals, policyDecisions, sourceEvents } from '@/lib/schema';
import {
  DEMO_ACTOR,
  DEMO_AGENTS,
  DEMO_INTENTS,
  DEMO_POLICY,
  DEMO_RUNS,
  DEMO_SOURCE_EVENTS,
} from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const introductionsModule: SeedModule = {
  name: 'introductions',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.maya;
    const contacts = [
      {
        id: DEMO_SOURCE_EVENTS.mayaAlex,
        providerEventId: '9000001',
        authorId: 'orbit-demo-alex-evaluations',
        authorName: 'Alex Chen',
        text: 'I can help teams design and run practical agent evaluations.',
      },
      {
        id: DEMO_SOURCE_EVENTS.mayaPriya,
        providerEventId: '9000002',
        authorId: 'orbit-demo-priya-support',
        authorName: 'Priya Patel',
        text: 'I am looking for help setting up evaluations for a support agent.',
      },
    ];
    await tx
      .insert(sourceEvents)
      .values(
        contacts.map((contact) => ({
          ...contact,
          agentId,
          provider: 'x',
          payload: {},
          ingestedAt: now,
        })),
      )
      .onConflictDoNothing();

    const profiles = await observedProfiles(tx, agentId, {
      sourceIds: contacts.map(({ id }) => id),
    });
    const first = profiles.find(({ sourceId }) => sourceId === DEMO_SOURCE_EVENTS.mayaAlex);
    const second = profiles.find(({ sourceId }) => sourceId === DEMO_SOURCE_EVENTS.mayaPriya);
    // A later identity merge can make the two saved fixture sources one person.
    if (!first || !second || first.personId === second.personId) return;
    const { personId: firstPersonId, ...firstProfile } = first;
    const { personId: secondPersonId, ...secondProfile } = second;

    const id = DEMO_INTENTS.mayaPeopleIntroduction;
    const runId = DEMO_RUNS.mayaSucceeded;
    const reasons = ['People tool permitted for this agent.'];
    await tx
      .insert(actionIntents)
      .values({
        id,
        agentId,
        runId,
        actionType: PEOPLE_INTRODUCE,
        idempotencyKey: 'orbit-demo:intent:maya-people-introduction',
        decision: 'allow',
        reasons,
      })
      .onConflictDoNothing();
    await tx
      .insert(policyDecisions)
      .values({
        id: DEMO_POLICY.mayaPeopleIntroduction,
        intentId: id,
        agentId,
        runId,
        actor: DEMO_ACTOR,
        actionType: PEOPLE_INTRODUCE,
        decision: 'allow',
        reasons,
      })
      .onConflictDoNothing();
    await tx
      .insert(introductionProposals)
      .values({
        id,
        agentId,
        runId,
        firstPersonId,
        secondPersonId,
        firstDisclosure: {
          ...firstProfile,
          blurb: 'Designs practical evaluations for agent products.',
        },
        secondDisclosure: {
          ...secondProfile,
          blurb: 'Is setting up evaluations for a support agent.',
        },
        rationale: 'Alex’s evaluation experience fits Priya’s current support project.',
        createdAt: now,
      })
      .onConflictDoNothing();
  },
};
