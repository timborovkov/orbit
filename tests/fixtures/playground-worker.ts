import { closeDb } from '@/lib/db';
import { claimJobs, completeJob } from '@/lib/queue/jobs';
import { processSimulationJob, SIMULATION_JOB_TYPE } from '@/lib/runtime/execute';
import type { ModelCall } from '@/lib/runtime/simulation';

const workerId = 'playwright-playground-fixture';
const inference: ModelCall = async ({ stage }) => ({
  decision: {
    relevant: true,
    priority: 0.9,
    reason: 'The fixture is a support question.',
    actions: [
      {
        type: 'reply',
        reason: 'Answer the support question.',
        draft: stage === 'main' ? 'Here is your deterministic support reply.' : null,
      },
    ],
  },
  inputTokens: 12,
  outputTokens: 8,
  costMicros: 50,
});
inference.quote = async () => ({
  upperBoundMicros: 100,
  endpoint: 'fixture',
  maxPrice: { prompt: 0, completion: 0, request: 0 },
});

try {
  const [job] = await claimJobs({ workerId, types: [SIMULATION_JOB_TYPE] });
  if (!job || job.payload.runId !== process.argv[2]) {
    throw new Error('Expected the fixture to claim the requested run.');
  }
  await processSimulationJob(job.payload, () => inference, undefined, { workerId, jobId: job.id });
  await completeJob(job.id, workerId);
} finally {
  await closeDb();
}
