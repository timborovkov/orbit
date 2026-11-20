# Durable follow-ups

First durable commitment (architecture §18.4): administrators schedule a
time-based follow-up for an agent. Orbit stores the commitment and its
execution state in PostgreSQL, enqueues a delayed job on the existing queue
(`followup.execute`) in the same transaction, and records an internal
outcome on the agent activity timeline when the job runs. There are no
external side effects in this increment.

## Data

| Concern    | Behaviour                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commitment | `follow_ups` — owner agent, source (`admin` today; `agent` reserved), subject, note, due time, status, attempts, linked job, cancellation, outcome |
| Activity   | `agent_activity_events` — timeline rows for completed, skipped, cancelled and failed outcomes                                                      |
| Queue      | Delayed `jobs` row with `available_at = due_at` and idempotency key `followup:<id>`                                                                |

## Lifecycle policy (skip-and-record)

Paused and stopped agents do **not** execute follow-ups.

- On pause or stop, pending follow-up jobs are cancelled with other agent work, and every still-`scheduled` follow-up is marked `skipped` with `outcome_kind = skipped_lifecycle`. An activity event is written immediately.
- If a claimed job observes a paused/stopped lifecycle at execution time, the handler also skip-and-records (exact-once via `status = scheduled` row lock).
- Follow-ups are **not** deferred until resume. Resuming the agent does not revive skipped commitments; schedule a new follow-up if needed.

## Exact-once and recovery

- Transactional enqueue ties the commitment row to its job.
- The worker finalizes with `SELECT … FOR UPDATE` and only transitions from `scheduled`, so retries and duplicate jobs cannot double-write outcomes.
- Delayed jobs survive worker restarts: polling reclaim picks up `pending` rows whose `available_at` has passed.

## Next increments (seams only)

- `source = 'agent'` for agent-scheduled follow-ups
- `wait_for_event` for resuming on inbound events
- Richer commitment kinds beyond internal outcomes
