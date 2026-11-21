ALTER TABLE simulation_runs ADD CONSTRAINT simulation_runs_agent_id_id_unique UNIQUE (agent_id, id);
ALTER TABLE email_messages ADD CONSTRAINT email_messages_agent_id_id_unique UNIQUE (agent_id, id);
ALTER TABLE source_events ADD CONSTRAINT source_events_agent_id_id_unique UNIQUE (agent_id, id);

CREATE TABLE agent_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('company', 'project')),
  subject text NOT NULL,
  topic text NOT NULL,
  identity_key text NOT NULL,
  fact text NOT NULL,
  quote text NOT NULL,
  run_id uuid NOT NULL,
  email_message_id uuid,
  source_event_id uuid,
  source_at timestamptz NOT NULL,
  learned_at timestamptz NOT NULL DEFAULT now(),
  expires_on date,
  review_on date,
  corrected_by text,
  corrected_at timestamptz,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  embedding vector(1536),
  embedding_model text,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', subject || ' ' || topic), 'A') ||
    setweight(to_tsvector('english', fact), 'B')
  ) STORED,
  UNIQUE (agent_id, subject_kind, identity_key),
  CONSTRAINT agent_memory_one_source CHECK (num_nonnulls(email_message_id, source_event_id) = 1),
  CONSTRAINT agent_memory_run_fk FOREIGN KEY (agent_id, run_id)
    REFERENCES simulation_runs(agent_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_memory_email_fk FOREIGN KEY (agent_id, email_message_id)
    REFERENCES email_messages(agent_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_memory_event_fk FOREIGN KEY (agent_id, source_event_id)
    REFERENCES source_events(agent_id, id) ON DELETE CASCADE
);

CREATE INDEX agent_memory_email_idx ON agent_memories(email_message_id) WHERE email_message_id IS NOT NULL;
CREATE INDEX agent_memory_event_idx ON agent_memories(source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX agent_memory_run_idx ON agent_memories(run_id);
CREATE INDEX agent_memory_search_idx ON agent_memories USING gin(search_vector);

ALTER TABLE evaluation_comparisons ADD COLUMN memory_snapshot jsonb;
