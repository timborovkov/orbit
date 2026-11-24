ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS web_research_seeds jsonb NOT NULL DEFAULT '{"queries":[],"sources":[]}'::jsonb;
