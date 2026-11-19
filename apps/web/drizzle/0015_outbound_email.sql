-- First outbound write adapter: administrator-approved email replies.
-- Generic outbound_actions tracks durable dispatch for email.send and future adapters.

CREATE TABLE outbound_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  intent_id uuid NOT NULL UNIQUE REFERENCES action_intents(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'blocked')),
  reason text,
  idempotency_key text NOT NULL UNIQUE,
  body text NOT NULL,
  email_message_id uuid REFERENCES email_messages(id) ON DELETE SET NULL,
  thread_id uuid,
  provider text,
  provider_message_id text,
  provider_result jsonb,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz
);

-- thread_id is informational only. A composite FK to email_threads(agent_id, id)
-- with ON DELETE SET NULL would also null agent_id (NOT NULL) and break thread merges.


CREATE INDEX outbound_actions_agent_thread ON outbound_actions (agent_id, thread_id, created_at DESC);
CREATE INDEX outbound_actions_email_message ON outbound_actions (email_message_id);
CREATE INDEX outbound_actions_status ON outbound_actions (status) WHERE status IN ('queued', 'sending');
