-- Separate identical text topics observed through different source identities.
UPDATE agent_memories memory SET identity_key = '[' || COALESCE(to_json(evidence.person_identity_id)::text, 'null') || ',' || memory.identity_key || ']'
FROM run_memory_evidence evidence
WHERE memory.subject_kind IN ('company', 'project') AND evidence.agent_id = memory.agent_id
  AND evidence.run_id = memory.run_id AND evidence.source_kind = memory.source_kind AND evidence.source_id = memory.source_id;

ALTER TABLE agent_memories ADD COLUMN note jsonb;
ALTER TABLE agent_memories DROP CONSTRAINT agent_memories_subject_check;
ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_subject_check CHECK (
  (subject_kind IN ('company', 'project', 'outcome') AND person_field IS NULL AND person_value IS NULL AND note IS NULL)
  OR (subject_kind = 'note' AND person_field IS NULL AND person_value IS NULL AND note IS NOT NULL
      AND jsonb_typeof(note) = 'object' AND note ?& ARRAY['kind', 'text']
      AND (note - 'kind' - 'text') = '{}'::jsonb
      AND jsonb_typeof(note->'kind') = 'string' AND note->>'kind' IN ('fact', 'observation', 'commitment')
      AND jsonb_typeof(note->'text') = 'string' AND char_length(btrim(note->>'text')) BETWEEN 1 AND 500)
  OR (subject_kind = 'person' AND note IS NULL
      AND person_field IS NOT NULL AND person_field IN ('company', 'job_title')
      AND person_value IS NOT NULL AND char_length(btrim(person_value)) BETWEEN 1 AND 120)
);

-- Only a confirmed delivery recorded against an owned, real source is a learning outcome.
-- Keep provider response bodies, recipient details and outbound message text out of memory.
CREATE VIEW memory_evidence AS
SELECT * FROM run_memory_evidence
UNION ALL
SELECT 'outcome', delivery.id, delivery.agent_id, intent.run_id, delivery.completed_at,
  delivery.action_type, NULL, 'Delivery confirmed (' || delivery.action_type || ').',
  'Recorded delivery', source.href, source.link_label, source.channel, source.person_identity_id,
  delivery.completed_at
FROM outbound_actions delivery
JOIN action_intents intent ON intent.id = delivery.intent_id AND intent.agent_id = delivery.agent_id
JOIN simulation_runs run ON run.id = intent.run_id AND run.agent_id = intent.agent_id
JOIN run_memory_evidence source ON source.agent_id = run.agent_id AND source.run_id = run.id
WHERE delivery.status = 'sent' AND delivery.provider_message_id IS NOT NULL AND delivery.completed_at IS NOT NULL
  AND run.origin IN ('email', 'discovery', 'channel')
  AND (SELECT count(*) FROM run_memory_evidence evidence WHERE evidence.agent_id = run.agent_id AND evidence.run_id = run.id) = 1;

CREATE FUNCTION record_delivery_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM agent_memories WHERE agent_id = OLD.agent_id AND source_kind = 'outcome' AND source_id = OLD.id;
    RETURN NULL;
  END IF;
  IF NEW.status <> 'sent' OR NEW.provider_message_id IS NULL OR NEW.completed_at IS NULL THEN
    DELETE FROM agent_memories WHERE agent_id = NEW.agent_id AND source_kind = 'outcome' AND source_id = NEW.id;
  ELSIF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.provider_message_id IS NULL OR OLD.completed_at IS NULL THEN
    INSERT INTO agent_memories (agent_id, subject_kind, subject, topic, identity_key, fact, quote,
      run_id, source_kind, source_id, source_at)
    SELECT agent_id, 'outcome', title, 'Delivery', source_id::text, body, body,
      run_id, source_kind, source_id, source_at
    FROM memory_evidence WHERE source_kind = 'outcome' AND agent_id = NEW.agent_id AND source_id = NEW.id
    ON CONFLICT (agent_id, subject_kind, identity_key) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER delivery_memory_changed AFTER INSERT OR UPDATE OF status, provider_message_id, completed_at OR DELETE
ON outbound_actions FOR EACH ROW EXECUTE FUNCTION record_delivery_memory();

ALTER TABLE agents
  ADD COLUMN memory_fact_retention_days integer CHECK (memory_fact_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN memory_note_retention_days integer CHECK (memory_note_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN memory_outcome_retention_days integer CHECK (memory_outcome_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN memory_maintenance_interval_days integer NOT NULL DEFAULT 1 CHECK (memory_maintenance_interval_days IN (1, 7)),
  ADD COLUMN memory_next_maintenance_at timestamptz;

CREATE INDEX agents_memory_maintenance_due_idx ON agents (memory_next_maintenance_at)
  WHERE memory_next_maintenance_at IS NOT NULL;
CREATE UNIQUE INDEX memory_maintenance_pending_idx ON jobs ((payload->>'agentId'))
  WHERE type = 'memory.maintain' AND status IN ('pending', 'claimed');
CREATE INDEX agent_memories_retention_idx ON agent_memories (agent_id, learned_at);
CREATE INDEX person_relationship_notes_retention_idx ON person_relationship_notes (agent_id, created_at);

CREATE OR REPLACE FUNCTION delete_memories_for_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM simulation_runs WHERE agent_id = OLD.agent_id AND id = OLD.run_id FOR UPDATE;
  DELETE FROM agent_memories
  WHERE agent_id = OLD.agent_id AND run_id = OLD.run_id
    AND ((source_kind = TG_ARGV[0] AND source_id = OLD.id) OR source_kind = 'outcome');
  RETURN NULL;
END;
$$;
