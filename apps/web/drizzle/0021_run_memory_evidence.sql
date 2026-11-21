-- Channel adapters project their original records through this view. Memory
-- keeps the source key, while the channel retains ownership of the content.
CREATE VIEW run_memory_evidence AS
SELECT
  'email'::text AS source_kind, id AS source_id, agent_id, run_id,
  received_at AS source_at, subject AS title, sender AS author, body,
  'Original inbound message'::text AS label,
  '/agents/' || agent_id || '?tab=email&emailThread=' || thread_id ||
    '&emailMessage=' || id || '#message-' || id AS href,
  'Open email thread'::text AS link_label
FROM email_messages
WHERE run_id IS NOT NULL AND body <> ''
UNION ALL
SELECT
  'event', id, agent_id, run_id, coalesce(provider_created_at, ingested_at),
  NULL::text, '@' || author_username, text,
  'Original discovery event',
  '/agents/' || agent_id || '?run=' || run_id || '#run-' || run_id,
  'View originating run'
FROM source_events
WHERE run_id IS NOT NULL AND text <> '';

ALTER TABLE agent_memories ADD COLUMN source_kind text, ADD COLUMN source_id uuid;

UPDATE agent_memories
SET source_kind = CASE WHEN email_message_id IS NOT NULL THEN 'email' ELSE 'event' END,
    source_id = coalesce(email_message_id, source_event_id);

ALTER TABLE agent_memories
  ALTER COLUMN source_kind SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  DROP COLUMN email_message_id,
  DROP COLUMN source_event_id;

-- A channel removing or replacing its source invalidates facts tied to that
-- record. Take the same run lock as capture so both operations can race safely.
CREATE FUNCTION delete_memories_for_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM simulation_runs WHERE agent_id = OLD.agent_id AND id = OLD.run_id FOR UPDATE;
  DELETE FROM agent_memories
  WHERE agent_id = OLD.agent_id AND run_id = OLD.run_id
    AND source_kind = TG_ARGV[0] AND source_id = OLD.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER email_memory_source_deleted AFTER DELETE ON email_messages
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL) EXECUTE FUNCTION delete_memories_for_source('email');

CREATE TRIGGER email_memory_source_changed AFTER UPDATE OF agent_id, run_id, subject, body ON email_messages
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL AND
  (OLD.agent_id, OLD.run_id, OLD.subject, OLD.body) IS DISTINCT FROM
  (NEW.agent_id, NEW.run_id, NEW.subject, NEW.body))
EXECUTE FUNCTION delete_memories_for_source('email');

CREATE TRIGGER event_memory_source_deleted AFTER DELETE ON source_events
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL) EXECUTE FUNCTION delete_memories_for_source('event');

CREATE TRIGGER event_memory_source_changed AFTER UPDATE OF agent_id, run_id, text ON source_events
FOR EACH ROW WHEN (OLD.run_id IS NOT NULL AND
  (OLD.agent_id, OLD.run_id, OLD.text) IS DISTINCT FROM (NEW.agent_id, NEW.run_id, NEW.text))
EXECUTE FUNCTION delete_memories_for_source('event');
