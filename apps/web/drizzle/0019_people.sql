CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id),
  home_person_id uuid NOT NULL UNIQUE REFERENCES people(id),
  channel text NOT NULL CHECK (channel IN ('email', 'x')),
  identity_key text NOT NULL,
  link_state text NOT NULL DEFAULT 'standalone'
    CHECK (link_state IN ('standalone', 'inferred', 'confirmed')),
  linked_via_id uuid REFERENCES person_identities(id),
  revision integer NOT NULL DEFAULT 0,
  UNIQUE (channel, identity_key)
);
CREATE INDEX person_identities_person ON person_identities(person_id);

CREATE TABLE person_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id),
  kind text NOT NULL CHECK (kind IN ('phone', 'instagram')),
  label text NOT NULL,
  provider_account_id text,
  UNIQUE (kind, provider_account_id),
  UNIQUE (person_id, kind, label)
);

CREATE TABLE person_identity_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES person_identities(id),
  from_person_id uuid NOT NULL REFERENCES people(id),
  to_person_id uuid NOT NULL REFERENCES people(id),
  action text NOT NULL CHECK (action IN ('infer', 'confirm', 'unlink', 'rollback')),
  actor text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_identity_changes_identity ON person_identity_changes(identity_id, created_at DESC);

CREATE TABLE person_link_rejections (
  first_identity_id uuid REFERENCES person_identities(id),
  second_identity_id uuid REFERENCES person_identities(id),
  CHECK (first_identity_id < second_identity_id),
  PRIMARY KEY (first_identity_id, second_identity_id)
);

ALTER TABLE email_messages
  ADD COLUMN person_identity_id uuid REFERENCES person_identities(id),
  ADD COLUMN person_claim text,
  ADD CONSTRAINT email_messages_agent_id_id_unique UNIQUE (agent_id, id);
ALTER TABLE source_events
  ADD COLUMN author_name text,
  ADD COLUMN person_identity_id uuid REFERENCES person_identities(id),
  ADD COLUMN person_claim text,
  ADD CONSTRAINT source_events_agent_id_id_unique UNIQUE (agent_id, id);
CREATE INDEX email_messages_person_identity ON email_messages(person_identity_id);
CREATE INDEX source_events_person_identity ON source_events(person_identity_id);
CREATE INDEX email_messages_person_claim ON email_messages(person_identity_id, received_at DESC, id DESC)
  WHERE person_claim IS NOT NULL;
CREATE INDEX email_messages_person_claim_handle ON email_messages(person_claim)
  WHERE person_claim IS NOT NULL;
CREATE INDEX source_events_person_handle ON source_events(lower(author_username), COALESCE(provider_created_at, ingested_at))
  WHERE person_identity_id IS NOT NULL;
CREATE INDEX source_events_person_claim ON source_events(person_identity_id, COALESCE(provider_created_at, ingested_at) DESC, id DESC)
  WHERE person_claim IS NOT NULL;

CREATE TABLE person_relationship_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  email_message_id uuid UNIQUE,
  source_event_id uuid UNIQUE,
  summary text NOT NULL,
  excerpt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(email_message_id, source_event_id) = 1),
  FOREIGN KEY (agent_id, email_message_id) REFERENCES email_messages(agent_id, id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id, source_event_id) REFERENCES source_events(agent_id, id) ON DELETE CASCADE
);
CREATE INDEX person_relationship_notes_agent ON person_relationship_notes(agent_id, created_at DESC);

-- Keep this equivalent to extractEmailAddress in the email runtime, including
-- its treatment of display names and the maximum address length.
CREATE FUNCTION person_email_key(sender text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN length(key) <= 320 AND key ~ '^[^<>[:space:]@]+@[^<>[:space:]@]+$' THEN key END
  FROM (SELECT lower(regexp_replace(
    coalesce(substring(sender FROM '<([^<>[:space:]@]+@[^<>[:space:]@]+)>'), sender),
    '^[[:space:]]+|[[:space:]]+$', '', 'g'
  )) AS key) normalized
$$;

CREATE FUNCTION observe_person_identity(identity_channel text, observed_key text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  identity uuid;
  person uuid;
BEGIN
  IF observed_key IS NULL OR observed_key = '' THEN
    RETURN NULL;
  END IF;
  SELECT id INTO identity FROM person_identities
    WHERE channel = identity_channel AND identity_key = observed_key;
  IF FOUND THEN
    RETURN identity;
  END IF;

  -- New identities, reconciliation and admin changes serialize membership writes.
  PERFORM pg_advisory_xact_lock(712605);
  SELECT id INTO identity FROM person_identities
    WHERE channel = identity_channel AND identity_key = observed_key;
  IF FOUND THEN
    RETURN identity;
  END IF;
  INSERT INTO people DEFAULT VALUES RETURNING id INTO person;
  INSERT INTO person_identities (person_id, home_person_id, channel, identity_key)
    VALUES (person, person, identity_channel, observed_key) RETURNING id INTO identity;
  RETURN identity;
END
$$;

UPDATE email_messages SET person_identity_id = observe_person_identity('email', person_email_key(sender));
UPDATE source_events SET person_identity_id = observe_person_identity('x', nullif(btrim(author_id), ''))
  WHERE provider = 'x';

CREATE FUNCTION assign_person_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'email_messages' THEN
    NEW.person_identity_id := observe_person_identity('email', person_email_key(NEW.sender));
  ELSIF NEW.provider = 'x' THEN
    NEW.person_identity_id := observe_person_identity('x', nullif(btrim(NEW.author_id), ''));
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER email_person_identity BEFORE INSERT ON email_messages
  FOR EACH ROW EXECUTE FUNCTION assign_person_identity();
CREATE TRIGGER x_person_identity BEFORE INSERT ON source_events
  FOR EACH ROW EXECUTE FUNCTION assign_person_identity();
