-- Phase 2: durable jobs, lifecycle, budgets, policy decisions and action intents.
-- Lifecycle replaces the previous status+mode pair with a single admin-controlled state.

ALTER TABLE agents ADD COLUMN lifecycle text NOT NULL DEFAULT 'shadow';
UPDATE agents SET lifecycle = CASE
  WHEN status = 'paused' THEN 'paused'
  WHEN mode = 'live' THEN 'live'
  ELSE 'shadow'
END;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_mode_check;
ALTER TABLE agents DROP COLUMN status;
ALTER TABLE agents DROP COLUMN mode;
ALTER TABLE agents ADD CONSTRAINT agents_lifecycle_check CHECK (lifecycle IN ('shadow','paused','live','stopped'));

ALTER TABLE agents ADD COLUMN budgets jsonb NOT NULL DEFAULT '{
  "dailySpendCents": 500,
  "monthlySpendCents": 5000,
  "dailyRequests": 200,
  "monthlyRequests": 5000,
  "dailyOutboundActions": 50,
  "monthlyOutboundActions": 1000,
  "maxConcurrentRuns": 1,
  "maxToolStepsPerRun": 10,
  "runDeadlineSeconds": 300
}'::jsonb;

ALTER TABLE agents ADD COLUMN enabled_tools jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_status_check;
ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_status_check
  CHECK (status IN ('queued','running','completed','failed','interrupted'));
DROP INDEX IF EXISTS simulation_runs_one_active;
CREATE UNIQUE INDEX simulation_runs_one_active ON simulation_runs(agent_id)
  WHERE status IN ('queued','running');
ALTER TABLE simulation_runs ALTER COLUMN status SET DEFAULT 'queued';
ALTER TABLE simulation_runs ADD COLUMN job_id uuid;
ALTER TABLE simulation_runs ADD COLUMN defer_reason text;

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','completed','failed','dead','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claimed_by text,
  finished_at timestamptz,
  last_error text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_claimable ON jobs(available_at, created_at)
  WHERE status = 'pending';
CREATE INDEX jobs_claim_expiry ON jobs(claim_expires_at)
  WHERE status = 'claimed';

ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id);

CREATE TABLE action_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  run_id uuid REFERENCES simulation_runs(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','deny','needs-approval','suppressed')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);
CREATE INDEX action_intents_agent_created ON action_intents(agent_id, created_at DESC);

CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  run_id uuid,
  action_type text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','deny','needs-approval','suppressed')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  intent_id uuid REFERENCES action_intents(id),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_decisions_agent_created ON policy_decisions(agent_id, created_at DESC);

CREATE TABLE usage_counters (
  agent_id uuid NOT NULL REFERENCES agents(id),
  period text NOT NULL CHECK (period IN ('day','month')),
  period_start date NOT NULL,
  spend_micros bigint NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  outbound_actions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, period, period_start)
);
