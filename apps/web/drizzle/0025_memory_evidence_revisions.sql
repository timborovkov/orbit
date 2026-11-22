ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_agent_id_id_unique UNIQUE (agent_id, id);

CREATE TABLE agent_memory_evidence_revisions (
  agent_id uuid NOT NULL,
  id uuid NOT NULL,
  revision uuid NOT NULL,
  subject text NOT NULL,
  topic text NOT NULL,
  quote text NOT NULL,
  source_at timestamptz NOT NULL,
  corrected_by text,
  run_id uuid NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  PRIMARY KEY (agent_id, id, revision),
  FOREIGN KEY (agent_id, id) REFERENCES agent_memories (agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, run_id) REFERENCES simulation_runs (agent_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_memory_evidence_revisions_source_idx
  ON agent_memory_evidence_revisions (agent_id, source_kind, source_id);

CREATE VIEW agent_memory_evidence_versions AS
SELECT agent_id, id, revision, subject, topic, quote, source_at, corrected_by, run_id, source_kind, source_id
FROM agent_memories
UNION ALL
SELECT agent_id, id, revision, subject, topic, quote, source_at, corrected_by, run_id, source_kind, source_id
FROM agent_memory_evidence_revisions;

CREATE FUNCTION archive_memory_evidence_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_memory_evidence_revisions
    (agent_id, id, revision, subject, topic, quote, source_at, corrected_by, run_id, source_kind, source_id)
  VALUES
    (OLD.agent_id, OLD.id, OLD.revision, OLD.subject, OLD.topic, OLD.quote, OLD.source_at,
      OLD.corrected_by, OLD.run_id, OLD.source_kind, OLD.source_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER agent_memory_revision_changed AFTER UPDATE OF revision ON agent_memories
FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision) EXECUTE FUNCTION archive_memory_evidence_revision();

-- Forget invalidated historical evidence even if its memory has a newer source.
CREATE FUNCTION delete_memory_evidence_revisions_for_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM simulation_runs WHERE agent_id = OLD.agent_id AND id = OLD.run_id FOR UPDATE;
  DELETE FROM agent_memory_evidence_revisions
  WHERE agent_id = OLD.agent_id AND run_id = OLD.run_id
    AND source_kind = TG_ARGV[0] AND source_id = OLD.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER email_memory_revisions_deleted AFTER DELETE ON email_messages
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL) EXECUTE FUNCTION delete_memory_evidence_revisions_for_source('email');

CREATE TRIGGER email_memory_revisions_changed AFTER UPDATE OF agent_id, run_id, subject, body ON email_messages
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL AND
  (OLD.agent_id, OLD.run_id, OLD.subject, OLD.body) IS DISTINCT FROM
  (NEW.agent_id, NEW.run_id, NEW.subject, NEW.body))
EXECUTE FUNCTION delete_memory_evidence_revisions_for_source('email');

CREATE TRIGGER event_memory_revisions_deleted AFTER DELETE ON source_events
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL) EXECUTE FUNCTION delete_memory_evidence_revisions_for_source('event');

CREATE TRIGGER event_memory_revisions_changed AFTER UPDATE OF agent_id, run_id, text ON source_events
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL AND
  (OLD.agent_id, OLD.run_id, OLD.text) IS DISTINCT FROM (NEW.agent_id, NEW.run_id, NEW.text))
EXECUTE FUNCTION delete_memory_evidence_revisions_for_source('event');
