import { closeDb, sqlClient } from '@/lib/db';
import { enqueueSimulation } from '@/lib/runtime/execute';

const sql = sqlClient();
try {
  // The CI job provisions a disposable, migrated database and deliberately supplies no API key.
  const [agent] =
    await sql`INSERT INTO agents(name, mission) VALUES ('Worker smoke', 'Test fixture') RETURNING id`;
  const [config] = await sql`
    INSERT INTO agent_configurations(agent_id, version, config, actor)
    SELECT ${agent.id}, 1, config, 'smoke' FROM templates WHERE id='support' RETURNING id
  `;
  const run = await enqueueSimulation({
    agentId: agent.id,
    configurationId: config.id,
    actor: 'smoke',
    input: 'Synthetic smoke fixture',
  });
  if (!run.runId) throw new Error('Could not queue fixture');

  for (let attempt = 0; attempt < 60; attempt++) {
    const [result] = await sql`
      SELECT r.status, r.result->>'error' AS error, j.status AS job_status, j.claimed_by
      FROM simulation_runs r JOIN jobs j ON r.job_id = j.id WHERE r.id = ${run.runId}
    `;
    if (result?.job_status === 'completed') {
      if (
        result.status !== 'failed' ||
        !result.error?.startsWith('No OpenRouter credential available.') ||
        result.claimed_by !== 'ci-smoke'
      ) {
        throw new Error('Worker fixture reached an unexpected outcome');
      }
      console.info('Worker claimed and processed the fixture.');
      break;
    }
    if (attempt === 59) throw new Error('Worker did not complete the fixture in time');
    await Bun.sleep(500);
  }
} finally {
  await closeDb();
}
