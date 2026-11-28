ALTER TABLE introduction_proposals
  ADD COLUMN disclosure_version integer NOT NULL DEFAULT 1;

ALTER TABLE recipient_consents
  ADD COLUMN disclosure_digest text;
