ALTER TABLE agents
  ADD COLUMN consent_required_tools jsonb NOT NULL DEFAULT '["introduce", "escalate"]'::jsonb;
