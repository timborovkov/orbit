ALTER TABLE follow_ups
  ADD COLUMN channel text,
  ADD COLUMN account_id text,
  ADD COLUMN conversation_id text,
  ADD COLUMN anchor_id uuid,
  ADD COLUMN originating_run_id uuid REFERENCES simulation_runs(id) ON DELETE SET NULL,
  ADD COLUMN reply_event_id uuid REFERENCES source_events(id) ON DELETE SET NULL,
  ADD COLUMN reply_email_id uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  ADD COLUMN continuation_run_id uuid REFERENCES simulation_runs(id) ON DELETE SET NULL,
  ADD COLUMN draft_run_id uuid UNIQUE REFERENCES simulation_runs(id) ON DELETE SET NULL,
  ADD COLUMN approval_intent_id uuid REFERENCES action_intents(id) ON DELETE SET NULL;

ALTER TABLE follow_ups DROP CONSTRAINT follow_ups_outcome_kind_check;
ALTER TABLE follow_ups ADD CONSTRAINT follow_ups_outcome_kind_check
  CHECK (outcome_kind IN ('executed', 'reply_received', 'draft_ready', 'skipped_lifecycle', 'cancelled', 'failed'));

CREATE INDEX follow_ups_waiting_conversation
  ON follow_ups (agent_id, channel, account_id, conversation_id)
  WHERE status = 'scheduled' AND wait_for_event = 'reply';
CREATE INDEX follow_ups_reply_event ON follow_ups (reply_event_id) WHERE reply_event_id IS NOT NULL;
CREATE INDEX follow_ups_reply_email ON follow_ups (reply_email_id) WHERE reply_email_id IS NOT NULL;
CREATE INDEX follow_ups_continuation_run ON follow_ups (continuation_run_id) WHERE continuation_run_id IS NOT NULL;
