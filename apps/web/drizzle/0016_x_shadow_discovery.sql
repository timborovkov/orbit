-- X shadow discovery: per-agent search query on versioned config, durable source
-- events with provider-id dedupe, and per-agent since_id cursors.

ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_origin_check;
ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_origin_check
  CHECK (origin IN ('playground', 'email', 'discovery'));

UPDATE agent_configurations
SET config = config || '{"xSearchQuery": ""}'::jsonb
WHERE NOT (config ? 'xSearchQuery');

UPDATE templates
SET config = config || '{"xSearchQuery": ""}'::jsonb
WHERE NOT (config ? 'xSearchQuery');

CREATE TABLE source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('x')),
  provider_event_id text NOT NULL,
  payload jsonb NOT NULL,
  text text NOT NULL,
  author_id text,
  author_username text,
  provider_created_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid UNIQUE REFERENCES simulation_runs(id) ON DELETE SET NULL,
  UNIQUE (agent_id, provider, provider_event_id)
);

CREATE INDEX source_events_agent_ingested ON source_events (agent_id, ingested_at DESC);

CREATE TABLE discovery_cursors (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('x')),
  since_id text,
  last_polled_at timestamptz,
  last_status text NOT NULL DEFAULT 'idle',
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, provider)
);
