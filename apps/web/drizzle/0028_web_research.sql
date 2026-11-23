ALTER TABLE agents ADD COLUMN web_crawl_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE agent_firecrawl_credentials (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  encrypted_key text NOT NULL
);

CREATE TABLE web_crawls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  run_id uuid NOT NULL,
  intent_id uuid NOT NULL UNIQUE REFERENCES action_intents(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id),
  seed_url text NOT NULL,
  origin_hash text NOT NULL,
  provider_job_id text,
  page_limit integer NOT NULL CHECK (page_limit BETWEEN 1 AND 25),
  depth_limit integer NOT NULL CHECK (depth_limit BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitting','running','cancelling','completed','failed','cancelled','unavailable')),
  completed_pages integer NOT NULL DEFAULT 0,
  discovered_pages integer NOT NULL DEFAULT 0,
  credits_used integer,
  cursor integer NOT NULL DEFAULT 0,
  poll_requests integer NOT NULL DEFAULT 0,
  cancel_requested_at timestamptz,
  cancellation_sent_at timestamptz,
  reason text,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT web_crawls_owned_run_fk FOREIGN KEY (agent_id, run_id) REFERENCES simulation_runs(agent_id, id) ON DELETE CASCADE
);
CREATE INDEX web_crawls_agent_created_idx ON web_crawls (agent_id, created_at);
CREATE UNIQUE INDEX web_crawls_one_active_idx ON web_crawls (agent_id)
  WHERE status IN ('queued','submitting','running','cancelling');

CREATE TABLE web_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  run_id uuid NOT NULL,
  intent_id uuid NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  crawl_id uuid REFERENCES web_crawls(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('web.search','web.read','web.crawl')),
  rank integer NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_citations_owned_run_fk FOREIGN KEY (agent_id, run_id) REFERENCES simulation_runs(agent_id, id) ON DELETE CASCADE,
  CONSTRAINT web_citations_intent_url_unique UNIQUE (intent_id, url)
);
CREATE INDEX web_citations_run_idx ON web_citations (agent_id, run_id);

ALTER TABLE knowledge_documents ADD COLUMN web_citation_id uuid REFERENCES web_citations(id) ON DELETE SET NULL;
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_web_import_unique UNIQUE (library_id, web_citation_id);
