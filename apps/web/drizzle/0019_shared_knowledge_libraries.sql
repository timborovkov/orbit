CREATE TABLE knowledge_libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE UNIQUE INDEX knowledge_libraries_name_idx ON knowledge_libraries (lower(name));

CREATE TABLE knowledge_library_grants (
  library_id uuid NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (library_id, agent_id)
);

CREATE INDEX knowledge_library_grants_agent_idx ON knowledge_library_grants (agent_id, library_id);

ALTER TABLE knowledge_documents
  ALTER COLUMN agent_id DROP NOT NULL,
  ADD COLUMN library_id uuid REFERENCES knowledge_libraries(id),
  ADD CONSTRAINT knowledge_documents_one_owner CHECK (num_nonnulls(agent_id, library_id) = 1);

CREATE INDEX knowledge_documents_library_created_idx
  ON knowledge_documents (library_id, created_at DESC) WHERE library_id IS NOT NULL;

ALTER TABLE knowledge_chunks ALTER COLUMN agent_id DROP NOT NULL;
