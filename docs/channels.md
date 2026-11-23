# Channel adapters

Orbit registers channel adapters in [the channel registry](../apps/web/src/lib/runtime/channels/registry.ts).
Email and X use the same run, policy and history services. Email retains its
signed webhook, mailbox settings and RFC threading. X retains its polling
cursor, post formatting and reciprocal identity-claim checks.

1. Give the adapter a stable channel ID and display label. Register it during
   web and worker startup via the shared registry. The adapter owns provider
   authentication, credential resolution, account-to-agent routing, and any
   provider-specific screening or permissions.
2. Normalize authorized inbound content and call `ingestChannelEvent` with the
   trusted agent ID, the channel ID, the provider’s event and author IDs, and
   the evidence text. Supply recipients only from trusted routing metadata.
   Omit secrets and authentication headers from the stored provider payload.
   Polling adapters that commit a cursor with a batch can use
   `persistChannelEvent` and `admitChannelEvent` inside the agent transaction.
   The database deduplicates events per agent, channel and account. Set
   `isReply` only when the adapter identifies a reply and supplies the
   canonical thread ID. The shared intake resolves eligible commitments in
   the same transaction as the saved reply.
3. Use the evaluation run mode for model-proposed actions. Register supported
   actions as channel-qualified IDs such as `provider.reply`. An administrator
   grants each supported action from the agent’s Access settings. The adapter
   can require review for every use or keep proposals editable in Shadow. It
   can also declare a recipient consent scope. The shared policy gateway checks action
   ownership, the grant, lifecycle, pause, approval and budgets before delivery.
4. Implement `prepareDelivery` to enforce provider connection, scope and
   recipient restrictions, including provider-specific opt-outs where they
   apply. Its transport receives an abort signal. Use the outbound row’s stable
   idempotency key when the provider supports it. For providers such as X, mark
   the send attempt durably before calling the API and retry confirmed
   rejections only. The shared dispatcher writes the outcome and usage to
   PostgreSQL. See [X replies](x-discovery-replies.md).

The source event links to History and supports People, evaluation cases, and
agent-owned memory evidence. Replays use the saved case input and never
dispatch or capture durable memory. The
[fixture channel integration test](../tests/channel-framework.test.ts) covers
registration through delivery against PostgreSQL without contacting a provider.

Draft-mode adapters can expose `followUp` with an approval-required channel
action and a function that loads an agent-owned conversation from the stored
anchor. The adapter supplies the drafting input and delivery references from
persisted data. See [durable follow-ups](follow-ups.md).
