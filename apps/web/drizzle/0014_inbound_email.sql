ALTER TABLE simulation_runs ADD COLUMN origin text NOT NULL DEFAULT 'playground'
  CHECK (origin IN ('playground', 'email'));

CREATE TABLE email_mailboxes (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  address text NOT NULL UNIQUE CHECK (address = lower(address)),
  enabled boolean NOT NULL
);

CREATE TABLE email_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provisional boolean NOT NULL DEFAULT false,
  UNIQUE (agent_id, id)
);

CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  resend_email_id text NOT NULL,
  event jsonb NOT NULL,
  sender text NOT NULL,
  subject text NOT NULL,
  received_at timestamptz NOT NULL,
  configuration_id uuid REFERENCES agent_configurations(id) ON DELETE SET NULL,
  receive_job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  run_id uuid UNIQUE REFERENCES simulation_runs(id) ON DELETE SET NULL,
  thread_id uuid NOT NULL,
  message_id text,
  in_reply_to text[] NOT NULL DEFAULT '{}',
  reference_ids text[] NOT NULL DEFAULT '{}',
  body text,
  skip_reason text,
  waiting_for_capacity boolean NOT NULL DEFAULT false,
  UNIQUE (agent_id, resend_email_id),
  FOREIGN KEY (agent_id, thread_id) REFERENCES email_threads(agent_id, id) ON DELETE CASCADE
);

CREATE INDEX email_messages_thread ON email_messages (agent_id, thread_id, received_at);
CREATE INDEX email_messages_message_id ON email_messages (agent_id, message_id);
