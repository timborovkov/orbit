# Durable follow-ups

Administrators can record internal reminders from the agent’s Follow-ups tab.
Agent Access has independent opt-in permissions to schedule a conversation
follow-up or wait for a reply. An agent can use either granted tool during a run
with a saved conversation on a supported channel. Email is the first channel
with a follow-up drafting adapter.

## Reply and deadline

Orbit saves the commitment and its delayed PostgreSQL job together. A reply
must be new, persisted inbound evidence for the same agent, channel, account
and conversation. Resend uses the canonical thread assigned from message
headers. New replies on the same thread close waiting commitments before the
database deadline and become evidence in the normal channel run. Retries of
the same delivery reuse the saved evidence. A late ancestor can merge an
email thread while the wait stays open for a new reply. A matched email stays
queued for continuation while the agent is over budget. Explicitly scheduled
follow-ups remain due at their chosen time.

At or after the deadline, the timer starts one draft run. It uses the stored
conversation, the originating configuration and existing agent budgets. A
successful draft opens one item in Approvals. Review, consent, lifecycle,
global pause and any channel-specific restrictions still apply to sending.
Activity shows the commitment deadline, outcome and links to its saved reply,
continuation run or approval.

Administrators can cancel while the timer or draft is pending. Pause and
stop close unresolved commitments and record a skip. Resume leaves those
commitments closed. Revoking a tool permission prevents new commitments. Existing commitments
remain available for explicit cancellation.

## Pending work interface

A domain enqueues its work in the same PostgreSQL transaction as its domain row,
using a stable idempotency key and `payload.agentId`. Add its job type to
`pendingWork` with these hooks.

- `handle(job, signal)` checks the current claim and may return
  `{ deferUntil }` to release the lease until the next poll.
- `finalizeLifecycle(tx, change)` runs with the agent row locked after generic
  queue cancellation. It fences any domain-owned claims and records the local
  outcome in the same transaction. Set `keepJobForCancellation` for work
  that must keep polling or contact its provider to confirm cancellation.
- `onDeadLetter(job, reason)` and `reconcile()` idempotently close stranded
  domain rows. Reconciliation covers crashes between a queue update and its
  domain finalizer.

A domain keeps its own evidence and provider work identifiers. The follow-up
worker serializes the terminal transition under the same agent lock as inbound
resolution and cancellation. The existing worker owns claim recovery and
backoff. Heartbeats and acknowledgements check the current claim and lease
deadline. See [the channel framework](channels.md) for the inbound contract.
