ALTER TABLE source_events
  ADD COLUMN account_id text,
  ADD COLUMN thread_id text,
  ADD COLUMN admission_status text CHECK (admission_status IN ('pending', 'deferred', 'admitted', 'rejected')),
  ADD COLUMN admission_reason text;

ALTER TABLE source_events DROP CONSTRAINT source_events_agent_id_provider_provider_event_id_key;
ALTER TABLE source_events ADD CONSTRAINT source_events_delivery_key
  UNIQUE NULLS NOT DISTINCT (agent_id, provider, account_id, provider_event_id);

CREATE INDEX source_events_thread_idx ON source_events (agent_id, provider, thread_id, account_id, ingested_at)
  WHERE thread_id IS NOT NULL;

-- Recover previously accepted events whose completed intake job created no run.
UPDATE jobs job SET status = 'pending', attempts = 0, available_at = now(),
  finished_at = NULL, claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL, updated_at = now()
FROM source_events source JOIN agents agent ON agent.id = source.agent_id
WHERE job.idempotency_key = 'channel.event:' || source.id AND job.type = 'channel.event'
  AND job.status = 'completed' AND source.run_id IS NULL AND agent.lifecycle IN ('live', 'shadow');

UPDATE source_events source SET
  admission_status = CASE WHEN source.run_id IS NOT NULL THEN 'admitted'
    WHEN job.status IN ('pending', 'claimed') THEN 'pending' ELSE 'rejected' END,
  admission_reason = CASE WHEN source.run_id IS NULL AND job.status NOT IN ('pending', 'claimed')
    THEN coalesce(job.last_error, 'Intake ended before a run was created.') END
FROM jobs job
WHERE job.idempotency_key = 'channel.event:' || source.id AND job.type = 'channel.event';

CREATE FUNCTION record_channel_intake_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE source_events SET admission_status = 'rejected', admission_reason =
    CASE NEW.status WHEN 'cancelled' THEN 'Channel intake was cancelled.'
      ELSE coalesce(NEW.last_error, 'Channel intake failed.') END
  WHERE id = CASE WHEN pg_input_is_valid(NEW.payload->>'sourceId', 'uuid')
    THEN (NEW.payload->>'sourceId')::uuid END
    AND agent_id::text = NEW.payload->>'agentId' AND run_id IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER channel_intake_job_ended AFTER UPDATE OF status ON jobs
FOR EACH ROW WHEN (NEW.type = 'channel.event' AND NEW.status IN ('cancelled', 'dead')
  AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION record_channel_intake_failure();
