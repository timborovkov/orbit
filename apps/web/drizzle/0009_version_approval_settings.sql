ALTER TABLE agent_configurations ADD COLUMN approval_settings jsonb;

UPDATE agent_configurations AS config
SET approval_settings = jsonb_build_object(
  'approvalTools', agent.approval_tools,
  'approvalExpiresAfterHours', agent.approval_expires_after_hours,
  'approvalOnReject', agent.approval_on_reject,
  'approvalSpendCents', agent.approval_spend_cents
)
FROM agents AS agent
WHERE config.agent_id = agent.id;

CREATE INDEX action_intents_run_review ON action_intents (run_id, review_status)
  WHERE run_id IS NOT NULL AND review_status IS NOT NULL;
