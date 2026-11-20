-- First durable commitment: admin-scheduled follow-ups with delayed queue jobs.
-- Parallel streams reserve 0015 (approved email replies), 0016 (X discovery), 0018 (evaluation/replay).

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- admin today; agent reserved for the next increment (agent-scheduled commitments).
  source text NOT NULL DEFAULT 'admin'
    CHECK (source IN ('admin', 'agent')),
  created_by text NOT NULL,
  subject text NOT NULL
    CHECK (char_length(subject) BETWEEN 1 AND 200),
  note text NOT NULL DEFAULT ''
    CHECK (char_length(note) <= 2000),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  started_at timestamptz,
  finished_at timestamptz,
  outcome text,
  outcome_kind text
    CHECK (
      outcome_kind IS NULL
      OR outcome_kind IN ('executed', 'skipped_lifecycle', 'cancelled', 'failed')
    ),
  -- Seam for event-driven resume (e.g. wait for inbound reply). Unused in this increment.
  wait_for_event text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX follow_ups_agent_due ON follow_ups (agent_id, due_at DESC);
CREATE INDEX follow_ups_agent_status ON follow_ups (agent_id, status, due_at);
CREATE UNIQUE INDEX follow_ups_job_id ON follow_ups (job_id) WHERE job_id IS NOT NULL;

-- Per-agent activity timeline ledger (follow-up outcomes today; more kinds later).
CREATE TABLE agent_activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  detail text,
  follow_up_id uuid REFERENCES follow_ups(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_activity_events_agent_created
  ON agent_activity_events (agent_id, created_at DESC);
