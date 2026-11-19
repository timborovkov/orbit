-- Human-in-the-loop: run suspension, expiry, reject behaviour, spend gate, global tools.

ALTER TABLE simulation_runs DROP CONSTRAINT IF EXISTS simulation_runs_status_check;
ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_status_check
  CHECK (status IN ('queued','running','awaiting_approval','completed','failed','interrupted'));

ALTER TABLE agents ADD COLUMN approval_expires_after_hours integer
  CHECK (approval_expires_after_hours IS NULL OR (approval_expires_after_hours >= 1 AND approval_expires_after_hours <= 720));
ALTER TABLE agents ADD COLUMN approval_on_reject text NOT NULL DEFAULT 'continue'
  CHECK (approval_on_reject IN ('continue','end'));
ALTER TABLE agents ADD COLUMN approval_spend_cents integer
  CHECK (approval_spend_cents IS NULL OR (approval_spend_cents >= 1 AND approval_spend_cents <= 100000000));

ALTER TABLE controls ADD COLUMN approval_tools jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE action_intents ADD COLUMN review_expires_at timestamptz;
ALTER TABLE action_intents ADD COLUMN review_note text;

CREATE INDEX action_intents_pending_global
  ON action_intents(created_at DESC)
  WHERE review_status = 'pending';

CREATE INDEX action_intents_review_expires
  ON action_intents(review_expires_at)
  WHERE review_status = 'pending' AND review_expires_at IS NOT NULL;

CREATE INDEX simulation_runs_awaiting_approval
  ON simulation_runs(agent_id, created_at DESC)
  WHERE status = 'awaiting_approval';
