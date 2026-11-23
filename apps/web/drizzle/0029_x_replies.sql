ALTER TABLE recipient_consents DROP CONSTRAINT recipient_consents_scope_check;
ALTER TABLE recipient_consents ADD CONSTRAINT recipient_consents_scope_check
  CHECK (scope IN ('introduce', 'escalate', 'x.reply'));

ALTER TABLE outbound_actions ADD COLUMN dispatch_attempt integer;

CREATE TABLE x_reply_credentials (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  user_id text NOT NULL UNIQUE,
  username text NOT NULL,
  encrypted_token text NOT NULL
);
