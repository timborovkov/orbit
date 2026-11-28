# Consent-based introductions

In the agent’s **Access → Consent**, grant **Introduction proposals** and, if
needed, **People search**. Any enabled agent can propose a pair in an eligible
run. For email delivery, also grant **Email introductions** under **Access → Approvals → Channel permissions**
and enable the agent’s email mailbox. Email delivery requires a configured
worker Resend key and a mailbox on the configured sending domain when one is
set.

Open **People → Introductions** and show both participants the exact subject,
body and two visible To addresses. Each person will see the other’s address.
Orbit requires one distinct email identity per person backed by inbound
email the proposing agent can access. If the preview is unavailable, check
the agent’s observations and People identity links.

Obtain each person’s decision separately and record its evidence on the
proposal. The first agreement leaves it waiting. The second creates a
read-only **Email introduction** in Approvals. Declining blocks the send.
Changing the disclosure or its identity bindings requires a new proposal
and fresh consent. Historical review-only proposals and their approvals
remain available. Use a new proposal to collect consent for email disclosure.

Switch the agent to **Live** and release the global outbound pause before
approving. Approval queues one new email from the agent’s mailbox. Both
addresses go in To, and replies can return to the agent’s mailbox. The worker
checks both current agreements, the addresses and identities, the approved
payload, the grant, Live mode, lifecycle, global pause, outbound budget and
sender configuration before sending. Revoking after approval blocks an
unsent introduction. Revocation cannot recall delivered mail.

The proposal and the agent’s **History → Activity** show the delivery
outcome and the Resend message ID upon provider acceptance. Retries reuse the
same provider idempotency key while Resend can still deduplicate the request.
A blocked or failed send stays in history.
Check the reason and confirm the provider outcome before considering a new
proposal.

## Verify the workflow

Run the targeted scenarios against a migrated PostgreSQL test database.

```sh
bun test tests/introductions.test.ts tests/outbound-email.test.ts
```

The scenarios use synthetic observations and a stubbed transport. The
introductions Playwright spec covers review-only history and the email
disclosure and approval views.

```sh
bun run build
bunx playwright test tests/introductions.spec.ts
```
