# Consent-based introductions

In an agent’s **Access → Consent**, grant **People search** and **Introduction
proposals** independently. Any agent with the proposal grant can propose a
pair in an eligible run. The agent can use People records with display names
from its own observations. Linking identities preserves the ownership of each
agent’s messages, relationship notes and memories.

Open **People → Introductions** to see the proposed match and exactly what
each person would share with the other. Record each person’s decision with an
evidence reference for the displayed name and match blurb. The decisions
apply to that proposal. An administrator records them after obtaining them
from the participants.

The first agreement leaves the proposal waiting. The second creates one
read-only draft in **Approvals**. A refusal blocks drafting. A revocation
closes any pending review and blocks dispatch even when the review history
shows approval. Changes to the people or disclosure require a new proposal
and fresh consent. Review and dispatch check the current decisions, identity
bindings, recipients and draft. Channel delivery is a separate release.

## Verify the workflow

Run the PostgreSQL acceptance scenarios against a migrated test database.

```sh
bun test tests/introductions.test.ts
```

The scenarios exercise Maya’s proposal, both independent decisions, refusal,
revocation after approval, the dispatch guard and linked-identity isolation.
For the administrator walkthrough, build the app and run the introductions
Playwright spec. The test seeds Maya and uses the local test database.

```sh
bun run build
bunx playwright test tests/introductions.spec.ts
```

To inspect the seeded example locally, run `bun run db:seed:demo` and open
**People → Introductions**. The demo uses synthetic contacts.
