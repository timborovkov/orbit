CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  filename text NOT NULL,
  title text NOT NULL,
  content_kind text NOT NULL CHECK (content_kind IN ('pdf', 'markdown', 'plain', 'faq')),
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error text,
  chunk_count integer NOT NULL DEFAULT 0,
  embedded_count integer NOT NULL DEFAULT 0,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX knowledge_documents_agent_created_idx
  ON knowledge_documents (agent_id, created_at DESC);
CREATE INDEX knowledge_documents_agent_status_idx
  ON knowledge_documents (agent_id, status);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  content_hash text NOT NULL,
  source_filename text NOT NULL,
  source_title text NOT NULL,
  page integer,
  section text,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  embedding vector(1536),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX knowledge_chunks_agent_document_idx
  ON knowledge_chunks (agent_id, document_id);
CREATE INDEX knowledge_chunks_search_vector_idx
  ON knowledge_chunks USING gin (search_vector);
CREATE INDEX knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
