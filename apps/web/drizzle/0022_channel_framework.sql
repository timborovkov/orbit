ALTER TABLE simulation_runs ADD COLUMN channel text;
ALTER TABLE simulation_runs DROP CONSTRAINT simulation_runs_origin_check;
ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_origin_check
  CHECK (origin IN ('playground', 'email', 'discovery', 'replay', 'channel')
    AND (origin <> 'channel' OR channel IS NOT NULL));
UPDATE simulation_runs SET channel = 'email' WHERE origin = 'email';
UPDATE simulation_runs SET channel = 'x' WHERE origin = 'discovery';

ALTER TABLE source_events DROP CONSTRAINT source_events_provider_check;
ALTER TABLE source_events ADD CONSTRAINT source_events_provider_check
  CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$');
ALTER TABLE discovery_cursors DROP CONSTRAINT discovery_cursors_provider_check;
ALTER TABLE discovery_cursors ADD CONSTRAINT discovery_cursors_provider_check
  CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$');

ALTER TABLE person_identities DROP CONSTRAINT person_identities_channel_check;
ALTER TABLE person_identities ADD CONSTRAINT person_identities_channel_check
  CHECK (channel ~ '^[a-z][a-z0-9_-]{0,39}$');

ALTER TABLE evaluation_cases ADD COLUMN source_channel text;
ALTER TABLE evaluation_cases DROP CONSTRAINT evaluation_cases_source_kind_check;
ALTER TABLE evaluation_cases ADD CONSTRAINT evaluation_cases_source_kind_check
  CHECK (source_kind IN ('playground', 'email', 'channel')
    AND (source_kind <> 'channel' OR source_channel IS NOT NULL));
UPDATE evaluation_cases SET source_channel = 'email' WHERE source_kind = 'email';

CREATE OR REPLACE VIEW run_memory_evidence AS
SELECT
  'email'::text AS source_kind, id AS source_id, agent_id, run_id,
  received_at AS source_at, subject AS title, sender AS author, body,
  'Original inbound message'::text AS label,
  '/agents/' || agent_id || '?tab=email&emailThread=' || thread_id ||
    '&emailMessage=' || id || '#message-' || id AS href,
  'Open email thread'::text AS link_label,
  'email'::text AS channel, person_identity_id, received_at AS observed_at
FROM email_messages
WHERE run_id IS NOT NULL AND body <> ''
UNION ALL
SELECT
  'event', id, agent_id, run_id, coalesce(provider_created_at, ingested_at),
  NULL::text, coalesce(nullif('@' || author_username, '@'), author_name), text,
  'Original channel event',
  '/agents/' || agent_id || '?run=' || run_id || '#run-' || run_id,
  'View originating run',
  provider, person_identity_id, ingested_at
FROM source_events
WHERE run_id IS NOT NULL AND text <> '';

CREATE OR REPLACE FUNCTION assign_person_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'email_messages' THEN
    NEW.person_identity_id := observe_person_identity('email', person_email_key(NEW.sender));
  ELSE
    NEW.person_identity_id := observe_person_identity(NEW.provider, nullif(btrim(NEW.author_id), ''));
  END IF;
  RETURN NEW;
END
$$;

ALTER TRIGGER x_person_identity ON source_events RENAME TO source_event_person_identity;
