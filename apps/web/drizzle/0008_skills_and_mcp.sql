CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  body text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  CONSTRAINT skills_version_positive CHECK (version >= 1)
);

CREATE TABLE agent_skills (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  url text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('http', 'sse')),
  encrypted_headers text,
  tool_allowlist jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_connections_name_format CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$')
);

CREATE TABLE agent_mcp_connections (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, connection_id)
);
