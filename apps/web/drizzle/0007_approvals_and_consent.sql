ALTER TABLE agents ADD COLUMN approval_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE simulation_runs ADD COLUMN recipients jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE action_intents ADD COLUMN recipients jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE action_intents ADD COLUMN review_status text
  CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE action_intents ADD COLUMN reviewed_by text;
ALTER TABLE action_intents ADD COLUMN reviewed_at timestamptz;
CREATE INDEX action_intents_review_queue ON action_intents(agent_id, review_status, created_at)
  WHERE review_status IS NOT NULL;

CREATE TABLE recipient_consents (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('introduce', 'escalate')),
  evidence text NOT NULL,
  granted boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  PRIMARY KEY (agent_id, recipient, scope)
);
