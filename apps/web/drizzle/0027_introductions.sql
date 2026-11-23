CREATE TABLE introduction_proposals (
  id uuid PRIMARY KEY REFERENCES action_intents(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  run_id uuid NOT NULL,
  first_person_id uuid NOT NULL REFERENCES people(id),
  second_person_id uuid NOT NULL REFERENCES people(id),
  first_disclosure jsonb NOT NULL,
  second_disclosure jsonb NOT NULL,
  rationale text NOT NULL,
  review_intent_id uuid UNIQUE REFERENCES action_intents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT introduction_proposals_distinct_people CHECK (first_person_id <> second_person_id),
  UNIQUE (id, agent_id),
  FOREIGN KEY (agent_id, run_id) REFERENCES simulation_runs(agent_id, id) ON DELETE CASCADE
);

CREATE INDEX introduction_proposals_created ON introduction_proposals (created_at DESC, id DESC);

ALTER TABLE recipient_consents
  ADD COLUMN introduction_id uuid,
  ADD COLUMN introduction_decision text,
  DROP CONSTRAINT recipient_consents_pkey,
  ADD CONSTRAINT recipient_consents_scope_key
    UNIQUE NULLS NOT DISTINCT (agent_id, recipient, scope, introduction_id),
  ADD CONSTRAINT recipient_consents_introduction_fk
    FOREIGN KEY (introduction_id, agent_id) REFERENCES introduction_proposals(id, agent_id) ON DELETE CASCADE,
  ADD CONSTRAINT recipient_consents_introduction_decision_check CHECK (
    (introduction_id IS NULL AND introduction_decision IS NULL)
    OR (
      introduction_id IS NOT NULL AND scope = 'introduce'
      AND introduction_decision IS NOT NULL
      AND introduction_decision IN ('agreed', 'declined', 'revoked')
      AND granted = (introduction_decision = 'agreed')
    )
  );

CREATE INDEX recipient_consents_introduction ON recipient_consents (introduction_id)
  WHERE introduction_id IS NOT NULL;
