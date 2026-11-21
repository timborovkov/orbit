ALTER TABLE agent_memories
  DROP CONSTRAINT agent_memories_subject_kind_check,
  ADD COLUMN person_field text,
  ADD COLUMN person_value text;

ALTER TABLE agent_memories ADD CONSTRAINT agent_memories_subject_check CHECK (
  (subject_kind IN ('company', 'project') AND person_field IS NULL AND person_value IS NULL)
  OR (subject_kind = 'person'
    AND person_field IS NOT NULL AND person_field IN ('company', 'job_title')
    AND person_value IS NOT NULL AND char_length(btrim(person_value)) BETWEEN 1 AND 120)
);

-- A memory follows the current person of its original evidence identity. Link
-- changes affect the projection without moving the memory or copying evidence.
CREATE VIEW person_memory_evidence AS
SELECT memory.id AS memory_id, memory.agent_id, identity.person_id
FROM agent_memories memory
JOIN run_memory_evidence evidence ON evidence.agent_id = memory.agent_id
  AND evidence.run_id = memory.run_id AND evidence.source_kind = memory.source_kind
  AND evidence.source_id = memory.source_id
JOIN person_identities identity ON identity.id = evidence.person_identity_id
WHERE memory.subject_kind = 'person';
