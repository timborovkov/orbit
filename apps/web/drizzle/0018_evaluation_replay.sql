-- Evaluation cases, comparisons, and replay origin for regression workflows.
-- Replay runs never dispatch external writes (enforced in the policy gateway).

ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_origin_check;
ALTER TABLE simulation_runs
  ADD CONSTRAINT simulation_runs_origin_check
  CHECK (origin IN ('playground', 'email', 'replay'));

CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('playground', 'email')),
  source_run_id uuid REFERENCES simulation_runs(id) ON DELETE SET NULL,
  source_email_message_id uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  input text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX evaluation_cases_agent_created
  ON evaluation_cases (agent_id, created_at DESC);

CREATE TABLE evaluation_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  left_configuration_id uuid NOT NULL REFERENCES agent_configurations(id),
  right_configuration_id uuid NOT NULL REFERENCES agent_configurations(id),
  left_run_id uuid REFERENCES simulation_runs(id) ON DELETE SET NULL,
  right_run_id uuid REFERENCES simulation_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  error text
);

CREATE INDEX evaluation_comparisons_agent_created
  ON evaluation_comparisons (agent_id, created_at DESC);
CREATE INDEX evaluation_comparisons_case_created
  ON evaluation_comparisons (case_id, created_at DESC);
