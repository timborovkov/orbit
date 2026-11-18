ALTER TABLE knowledge_chunks
  ADD COLUMN embedding_model text,
  ADD COLUMN embedding_dimensions integer;
