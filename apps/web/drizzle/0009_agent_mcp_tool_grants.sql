ALTER TABLE agent_mcp_connections
  ADD COLUMN tool_names text[] NOT NULL DEFAULT '{}';
