import { jobs, runs } from '@/lib/schema';
import { demoRuns } from '@/lib/seed/catalog';
import { demoTime } from '@/lib/seed/clock';
import { DEMO_ACTOR } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const runsModule: SeedModule = {
  name: 'runs',
  async apply({ tx, now }) {
    for (const row of demoRuns()) {
      const createdAt = demoTime(now, row.createdOffsetMs);
      const finishedAt = row.finishedOffsetMs === null ? null : demoTime(now, row.finishedOffsetMs);
      const expiresAt = demoTime(now, row.expiresOffsetMs);
      const jobStatus =
        row.status === 'completed' ? 'completed' : row.status === 'failed' ? 'failed' : 'cancelled';

      await tx
        .insert(jobs)
        .values({
          id: row.jobId,
          type: 'simulation',
          payload: { runId: row.id, agentId: row.agentId },
          status: jobStatus,
          attempts: row.status === 'failed' ? 2 : 1,
          maxAttempts: 5,
          availableAt: createdAt,
          claimedAt: createdAt,
          claimExpiresAt: expiresAt,
          claimedBy: 'demo-worker',
          finishedAt,
          lastError: row.status === 'failed' ? row.result.error : null,
          idempotencyKey: `orbit-demo:run:${row.id}`,
          createdAt,
          updatedAt: finishedAt ?? createdAt,
        })
        .onConflictDoUpdate({
          target: jobs.id,
          set: {
            type: 'simulation',
            payload: { runId: row.id, agentId: row.agentId },
            status: jobStatus,
            attempts: row.status === 'failed' ? 2 : 1,
            finishedAt,
            lastError: row.status === 'failed' ? row.result.error : null,
            idempotencyKey: `orbit-demo:run:${row.id}`,
            updatedAt: finishedAt ?? createdAt,
          },
        });

      await tx
        .insert(runs)
        .values({
          id: row.id,
          agentId: row.agentId,
          configurationId: row.configurationId,
          input: row.input,
          recipients: row.recipients,
          status: row.status,
          result: row.result,
          actor: DEMO_ACTOR,
          createdAt,
          finishedAt,
          expiresAt,
          jobId: row.jobId,
          deferReason: row.deferReason,
          executionToken: null,
        })
        .onConflictDoUpdate({
          target: runs.id,
          set: {
            agentId: row.agentId,
            configurationId: row.configurationId,
            input: row.input,
            recipients: row.recipients,
            status: row.status,
            result: row.result,
            actor: DEMO_ACTOR,
            createdAt,
            finishedAt,
            expiresAt,
            jobId: row.jobId,
            deferReason: row.deferReason,
            executionToken: null,
          },
        });
    }
  },
};
