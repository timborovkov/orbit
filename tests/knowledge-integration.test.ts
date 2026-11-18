import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import postgres from 'postgres';

import { stubEmbedders } from '@/lib/knowledge/embed';
import { processKnowledgeDocument } from '@/lib/knowledge/process';
import { searchKnowledge } from '@/lib/knowledge/search';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { executeKnowledgeSearchTool } from '@/lib/runtime/tools/knowledge-search';
import { putObject } from '@/lib/storage/objects';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://orbit:orbit_dev@localhost:5432/orbit_test';
process.env.DATABASE_URL = databaseUrl;
process.env.APP_URL = 'http://localhost:3000';
process.env.AUTH_DISABLED = 'false';
process.env.ORBIT_ADMIN_EMAIL = 'admin@example.com';
process.env.ORBIT_ADMIN_PASSWORD = 'test-only-password-123456';
process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
process.env.S3_REGION = process.env.S3_REGION ?? 'us-east-1';
process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'orbit';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'orbit_local';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'orbit_local_storage_only';
process.env.KNOWLEDGE_EMBEDDING_STUB = 'true';

const sql = postgres(databaseUrl);
const ids: string[] = [];
const objectKeys: string[] = [];

afterAll(async () => {
  for (const id of ids) {
    await sql`DELETE FROM knowledge_chunks WHERE agent_id=${id}`;
    await sql`DELETE FROM knowledge_documents WHERE agent_id=${id}`;
    await sql`DELETE FROM policy_decisions WHERE agent_id=${id}`;
    await sql`DELETE FROM action_intents WHERE agent_id=${id}`;
    await sql`DELETE FROM agent_configurations WHERE agent_id=${id}`;
    await sql`DELETE FROM agents WHERE id=${id}`;
  }
  await sql.end();
});

test('knowledge pipeline extracts, embeds once, and hybrid-searches with citations', async () => {
  const agentId = randomUUID();
  const documentId = randomUUID();
  ids.push(agentId);
  const objectKey = `agents/${agentId}/knowledge/${documentId}/support.faq`;
  objectKeys.push(objectKey);

  await sql`
    INSERT INTO agents(id,name,mission,lifecycle,budgets,enabled_tools)
    VALUES (
      ${agentId},
      'Knowledge Agent',
      'Answer with citations',
      'shadow',
      ${sql.json({
        dailySpendCents: null,
        monthlySpendCents: null,
        dailyRequests: 1000,
        monthlyRequests: 10000,
        dailyOutboundActions: 100,
        monthlyOutboundActions: 1000,
        maxConcurrentRuns: 3,
        maxToolStepsPerRun: 10,
        runDeadlineSeconds: 300,
      })},
      ${sql.json([])}
    )
  `;

  const body = Buffer.from(
    `Q: How do I reset my password?\nA: Open Settings → Security → Reset password.\n\nQ: Where are invoices?\nA: Open Billing and download the PDF invoice.\n`,
  );
  await putObject(objectKey, body, 'text/x-faq');
  await sql`
    INSERT INTO knowledge_documents(
      id, agent_id, filename, title, content_kind, mime_type, byte_size, object_key, status
    ) VALUES (
      ${documentId},
      ${agentId},
      'support.faq',
      'Support FAQ',
      'faq',
      'text/x-faq',
      ${body.byteLength},
      ${objectKey},
      'pending'
    )
  `;

  let embedCalls = 0;
  const base = stubEmbedders();
  const countingEmbedMany = async (values: string[], signal?: AbortSignal) => {
    embedCalls += 1;
    return base.embedMany(values, signal);
  };

  await processKnowledgeDocument({ documentId, agentId }, countingEmbedMany);

  const [ready] =
    await sql`SELECT status, chunk_count, embedded_count FROM knowledge_documents WHERE id=${documentId}`;
  expect(ready.status).toBe('ready');
  expect(Number(ready.chunk_count)).toBeGreaterThan(0);
  expect(Number(ready.embedded_count)).toBe(Number(ready.chunk_count));
  expect(embedCalls).toBe(1);

  // Retry must not re-pay for embeddings that already exist for unchanged chunks.
  await processKnowledgeDocument({ documentId, agentId }, countingEmbedMany);
  expect(embedCalls).toBe(1);

  const [stored] =
    await sql`SELECT embedding_model, embedding_dimensions FROM knowledge_chunks WHERE document_id=${documentId} LIMIT 1`;
  expect(stored.embedding_model).toBeTruthy();
  expect(Number(stored.embedding_dimensions)).toBeGreaterThan(0);

  // A model change must invalidate reuse and re-embed.
  const previousModel = process.env.KNOWLEDGE_EMBEDDING_MODEL;
  process.env.KNOWLEDGE_EMBEDDING_MODEL = 'openai/text-embedding-3-large';
  try {
    await processKnowledgeDocument({ documentId, agentId }, countingEmbedMany);
  } finally {
    if (previousModel === undefined) delete process.env.KNOWLEDGE_EMBEDDING_MODEL;
    else process.env.KNOWLEDGE_EMBEDDING_MODEL = previousModel;
  }
  expect(embedCalls).toBe(2);

  const result = await searchKnowledge({
    agentId,
    query: 'reset password',
    embedQuery: base.embedOne,
  });
  expect(result.hits.length).toBeGreaterThan(0);
  expect(result.hits[0]?.sourceFilename).toBe('support.faq');
  expect(result.hits[0]?.content.toLowerCase()).toContain('password');
  expect(result.hits[0]?.reasons.length).toBeGreaterThan(0);

  await sql`UPDATE controls SET paused=false`;
  const ctx = await loadPolicyContext(agentId, 'tester@example.com');
  expect(ctx).toBeTruthy();
  const policy = await authorizeAction(ctx!, {
    type: KNOWLEDGE_SEARCH_TOOL,
    idempotencyKey: `knowledge-search-${documentId}`,
    readOnly: true,
    payload: { query: 'invoices' },
  });
  expect(policy.decision).toBe('allow');

  // Tool path with stubbed env key resolution via direct search helper already covered;
  // ensure the tool module exports remain importable for the worker/web boundary.
  expect(typeof executeKnowledgeSearchTool).toBe('function');
});
