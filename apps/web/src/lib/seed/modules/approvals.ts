import { actionIntents, policyDecisions } from '@/lib/schema';
import { demoTime } from '@/lib/seed/clock';
import { DEMO_ACTOR, DEMO_AGENTS, DEMO_INTENTS, DEMO_POLICY, DEMO_RUNS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

/** Pending / reviewed proposals so Approvals and Access screens look realistic. */
export const approvalsModule: SeedModule = {
  name: 'approvals',
  async apply({ tx, now }) {
    const rows = [
      {
        id: DEMO_INTENTS.sarahEscalatePending,
        agentId: DEMO_AGENTS.sarah,
        runId: DEMO_RUNS.sarahSucceeded,
        actionType: 'escalate',
        recipients: ['acct-support-42'],
        reviewStatus: 'pending' as const,
        reviewedBy: null as string | null,
        reviewedAt: null as Date | null,
        payload: {
          reason: 'Account-specific worker logs may need a human.',
          draft: null,
        },
        decision: 'needs-approval',
        reasons: ['escalate requires administrator approval for this agent.'],
        idempotencyKey: 'orbit-demo:intent:sarah-escalate',
        createdOffsetMs: -27 * 60 * 60 * 1000,
        policyId: DEMO_POLICY.sarahEscalate,
      },
      {
        id: DEMO_INTENTS.mayaIntroduceApproved,
        agentId: DEMO_AGENTS.maya,
        runId: DEMO_RUNS.mayaSucceeded,
        actionType: 'introduce',
        recipients: ['alex-evals', 'priya-support'],
        reviewStatus: 'approved' as const,
        reviewedBy: DEMO_ACTOR,
        reviewedAt: demoTime(now, -46 * 60 * 60 * 1000),
        payload: {
          reason: 'Complementary skills with mutual benefit.',
          draft:
            'Alex, meet Priya — she is looking for eval patterns for support agents. Priya, Alex has shipped harnesses in this space.',
        },
        decision: 'needs-approval',
        reasons: ['introduce requires administrator approval for this agent.'],
        idempotencyKey: 'orbit-demo:intent:maya-introduce-approved',
        createdOffsetMs: -47 * 60 * 60 * 1000,
        policyId: DEMO_POLICY.mayaIntroduce,
      },
      {
        id: DEMO_INTENTS.mayaIntroducePending,
        agentId: DEMO_AGENTS.maya,
        runId: null,
        actionType: 'introduce',
        recipients: ['jordan-design', 'sam-research'],
        reviewStatus: 'pending' as const,
        reviewedBy: null,
        reviewedAt: null,
        payload: {
          reason: 'Design systems meet research ops — awaiting admin review.',
          draft: null,
        },
        decision: 'needs-approval',
        reasons: ['introduce requires administrator approval for this agent.'],
        idempotencyKey: 'orbit-demo:intent:maya-introduce-pending',
        createdOffsetMs: -4 * 60 * 60 * 1000,
        policyId: null as string | null,
      },
    ];

    for (const row of rows) {
      const createdAt = demoTime(now, row.createdOffsetMs);
      await tx
        .insert(actionIntents)
        .values({
          id: row.id,
          agentId: row.agentId,
          runId: row.runId,
          actionType: row.actionType,
          recipients: row.recipients,
          reviewStatus: row.reviewStatus,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          payload: row.payload,
          idempotencyKey: row.idempotencyKey,
          decision: row.decision,
          reasons: row.reasons,
          createdAt,
        })
        .onConflictDoUpdate({
          target: actionIntents.id,
          set: {
            agentId: row.agentId,
            runId: row.runId,
            actionType: row.actionType,
            recipients: row.recipients,
            reviewStatus: row.reviewStatus,
            reviewedBy: row.reviewedBy,
            reviewedAt: row.reviewedAt,
            payload: row.payload,
            idempotencyKey: row.idempotencyKey,
            decision: row.decision,
            reasons: row.reasons,
            createdAt,
          },
        });

      if (row.policyId) {
        await tx
          .insert(policyDecisions)
          .values({
            id: row.policyId,
            agentId: row.agentId,
            runId: row.runId,
            actionType: row.actionType,
            decision: row.decision,
            reasons: row.reasons,
            intentId: row.id,
            actor: DEMO_ACTOR,
            createdAt,
          })
          .onConflictDoUpdate({
            target: policyDecisions.id,
            set: {
              agentId: row.agentId,
              runId: row.runId,
              actionType: row.actionType,
              decision: row.decision,
              reasons: row.reasons,
              intentId: row.id,
              actor: DEMO_ACTOR,
              createdAt,
            },
          });
      }
    }
  },
};
