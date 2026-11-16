CREATE TABLE sessions (token_hash text PRIMARY KEY, email text NOT NULL, credential_hash text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, mission text NOT NULL, status text NOT NULL DEFAULT 'paused' CHECK (status IN ('paused','active')), mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('simulation','shadow','live')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE controls (id integer PRIMARY KEY CHECK (id = 1), paused boolean NOT NULL DEFAULT true);
INSERT INTO controls VALUES (1, true);
CREATE TABLE audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE login_attempts (identity text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
