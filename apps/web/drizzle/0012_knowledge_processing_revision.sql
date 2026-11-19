ALTER TABLE knowledge_documents
  ADD COLUMN revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN processing_token uuid;

-- Keep the latest unfinished job usable for documents queued before this migration.
WITH latest_jobs AS (
  SELECT DISTINCT ON (documents.id) jobs.id, documents.revision
  FROM jobs
  JOIN knowledge_documents AS documents
    ON documents.id::text = jobs.payload->>'documentId'
   AND documents.agent_id::text = jobs.payload->>'agentId'
  WHERE jobs.type = 'knowledge.process' AND jobs.status IN ('pending', 'claimed')
  ORDER BY documents.id, jobs.created_at DESC, jobs.id DESC
)
UPDATE jobs
SET payload = jobs.payload || jsonb_build_object('revision', latest_jobs.revision)
FROM latest_jobs WHERE jobs.id = latest_jobs.id;
