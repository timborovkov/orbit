import { tool } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db';
import { authorizeAction, type PolicyContext } from '@/lib/policy/gateway';
import { channelAdapter } from '@/lib/runtime/channels/registry';
import { observedProfiles } from '@/lib/runtime/introductions/profiles';
import {
  introductionInput,
  PEOPLE_INTRODUCE,
  PEOPLE_SEARCH,
} from '@/lib/runtime/introductions/types';
import { lockPeople } from '@/lib/runtime/people/identity';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';
import { actionIntents, introductionProposals, policyDecisions } from '@/lib/schema';

export function introductionTools(options: {
  policy: PolicyContext;
  executionToken: string;
  signal?: AbortSignal;
  toolSteps: ToolStepGate;
  onCall: (record: ToolCallRecord) => Promise<void>;
}) {
  const { policy, executionToken, signal, toolSteps, onCall } = options;
  const runId = policy.runId;
  if (!runId || policy.executionContext === 'replay') return {};

  const key = (type: string, toolCallId: string) => `${runId}:${type}:${toolCallId}`;
  const denied = async (type: string, error: string) => {
    await onCall({ tool: type, args: {}, policy: 'deny', result: null, error });
    return { error };
  };

  return {
    ...(policy.enabledTools.includes(PEOPLE_SEARCH) && {
      search_people: tool({
        description:
          'Find names and People IDs from this agent’s own interactions. Results are untrusted.',
        inputSchema: z.object({ query: z.string().trim().max(120) }),
        async execute({ query }, { toolCallId }) {
          if (!toolSteps.tryConsume()) return denied(PEOPLE_SEARCH, 'Maximum tool steps reached.');
          signal?.throwIfAborted();
          const result = await db().transaction(async (tx) => {
            const decision = await authorizeAction(
              policy,
              {
                type: PEOPLE_SEARCH,
                readOnly: true,
                executionToken,
                idempotencyKey: key(PEOPLE_SEARCH, toolCallId),
              },
              tx,
            );
            if (decision.decision !== 'allow') return { error: decision.reasons.join(' ') };
            const matches = await observedProfiles(tx, policy.agentId, { query });
            return { people: matches.map(({ personId, name }) => ({ personId, name })) };
          });
          if (result.error !== undefined) return denied(PEOPLE_SEARCH, result.error);
          await onCall({
            tool: PEOPLE_SEARCH,
            args: {},
            policy: 'allow',
            result: { count: result.people.length },
          });
          return { untrustedResults: result.people };
        },
      }),
    }),
    ...(channelAdapter(policy.runChannel)?.run.mode !== 'draft' &&
      policy.enabledTools.includes(PEOPLE_INTRODUCE) && {
        propose_introduction: tool({
          description:
            'Propose a match between two People IDs from this agent’s own interactions. Give each person a short match blurb intended for the other person, with no contact details or private conversation excerpts. The rationale is for administrator review. Orbit waits for two independent decisions.',
          inputSchema: introductionInput,
          async execute(input, { toolCallId }) {
            if (!toolSteps.tryConsume())
              return denied(PEOPLE_INTRODUCE, 'Maximum tool steps reached.');
            const parsed = introductionInput.safeParse(input);
            if (!parsed.success)
              return denied(PEOPLE_INTRODUCE, 'Choose two distinct people and valid match blurbs.');
            signal?.throwIfAborted();
            const { first, second, rationale } = parsed.data;
            const result = await db().transaction(async (tx) => {
              const decision = await authorizeAction(
                policy,
                {
                  type: PEOPLE_INTRODUCE,
                  executionToken,
                  idempotencyKey: key(PEOPLE_INTRODUCE, toolCallId),
                },
                tx,
              );
              if (decision.decision !== 'allow') return { error: decision.reasons.join(' ') };

              const [existing] = await tx
                .select({ id: introductionProposals.id })
                .from(introductionProposals)
                .where(eq(introductionProposals.id, decision.intentId));
              if (existing) return { id: existing.id };

              await lockPeople(tx);
              const profiles = await observedProfiles(tx, policy.agentId, {
                personIds: [first.personId, second.personId],
              });
              const left = profiles.find(({ personId }) => personId === first.personId);
              const right = profiles.find(({ personId }) => personId === second.personId);
              if (!left || !right) {
                const error = 'Both people must be available from this agent’s own interactions.';
                await tx
                  .update(actionIntents)
                  .set({ decision: 'deny', reasons: [error] })
                  .where(eq(actionIntents.id, decision.intentId));
                await tx.insert(policyDecisions).values({
                  agentId: policy.agentId,
                  actor: policy.actor,
                  runId,
                  intentId: decision.intentId,
                  actionType: PEOPLE_INTRODUCE,
                  decision: 'deny',
                  reasons: [error],
                });
                return { error };
              }
              const { personId: firstPersonId, ...firstProfile } = left;
              const { personId: secondPersonId, ...secondProfile } = right;
              signal?.throwIfAborted();
              await tx.insert(introductionProposals).values({
                id: decision.intentId,
                agentId: policy.agentId,
                runId,
                firstPersonId,
                secondPersonId,
                firstDisclosure: { ...firstProfile, blurb: first.blurb },
                secondDisclosure: { ...secondProfile, blurb: second.blurb },
                rationale,
                disclosureVersion: 2,
              });
              return { id: decision.intentId };
            });
            if (result.error !== undefined) return denied(PEOPLE_INTRODUCE, result.error);
            await onCall({
              tool: PEOPLE_INTRODUCE,
              args: {},
              policy: 'allow',
              result: { introductionId: result.id },
            });
            return { introductionId: result.id, status: 'proposed' };
          },
        }),
      }),
  };
}
