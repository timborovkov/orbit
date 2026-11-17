![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

A privately deployed control centre for persistent AI representatives, built with Next.js, Bun and PostgreSQL.

The console supports administrator login, template-based agents, versioned configurations, private profile pictures, durable worker-backed simulations through OpenRouter, agent lifecycle controls, hard budgets, proposal approvals, scoped consent and a policy gateway. Schedules, channel integrations and live external actions are deferred.

## Start locally

Install Bun 1.4.4 and Docker. Copy `.env.example` to `.env` and replace the administrator email and password (at least 16 characters).

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres rustfs
bun run db:migrate
bun run storage:setup
bun run dev
```

Open http://localhost:3000.

- [Development and testing](docs/development.md), including local development without login.
- [Deployment and environment variables](docs/deployment.md).
- [Architecture](architecture.md), [design](design.md) and [contributing](CONTRIBUTING.md).

### Agent templates and manual simulation

Apply migrations with `bun run db:migrate`. The database contains Sales and GTM,
Customer Support, Superconnector, Community Manager, Recruitment, Partnerships and
Blank presets. Both model defaults are `deepseek/deepseek-v4.1-flash-1017`
(DeepSeek V4.1 Flash 1017, verified against the OpenRouter catalog on 16 November 2026).
Migration `0002` updates the original starter-model defaults while preserving customized
models and existing agent configuration snapshots. Edit their defaults under **Templates**; existing agents keep their
own copies. Open an agent from the overview to save versioned configuration,
manage its OpenRouter key under **Access**, and paste an input into **Playground**.
Configuration is grouped into Identity, Behaviour and Models; **History** retains runs
and configuration versions. Switching views preserves unsaved form text. Select a
saved version to replay an older configuration. Unsaved edits are not used by runs.

Optionally set `OPENROUTER_API_KEY` on the web service as a default OpenRouter key.
Inference uses an agent’s own encrypted key when present; otherwise it uses the
environment default. Rotating the env var takes effect for every agent without an
override. The Access tab shows whether the agent key, the environment default or
neither is in use, without revealing key values or prefixes.

Set `ORBIT_ENCRYPTION_KEY` to a random 32-byte hex value (`openssl rand -hex 32`) in
the web service environment before saving per-agent credentials. Keep it outside
PostgreSQL and retain a secure backup across deployments; changing it makes existing
encrypted credentials unreadable. Replace or remove individual OpenRouter keys in the
agent workspace. Per-agent keys are AES-256-GCM encrypted with agent-bound
authenticated data, never returned to the browser, and never included in model prompts
or diagnostic logs. The environment default does not require encryption because it is
not stored in PostgreSQL. The application still starts without a master key; only
per-agent credential save/decrypt operations need it.

Simulations enqueue a durable PostgreSQL job that the Bun worker executes. They make
real, potentially billable OpenRouter inference calls: one evaluator call and, only
for relevant candidates, one main-model call. Hard budgets default to architecture
§17 (including ten tool steps and a five-minute run deadline). There are no external
action adapters yet; every candidate action passes the policy gateway, which records
an intent and allow/deny/needs-approval/suppressed decision. Global pause, lifecycle,
tool enablement and budgets are enforced there. Missing credentials fall back to
optional `OPENROUTER_API_KEY` (web and worker), then produce an inspectable failure.
Provider error bodies are discarded. Run history shows token usage and reported
cost. Access supports independent daily and monthly spend caps, including **No cap**.
Before a capped call the worker reserves an upper bound using a priced endpoint
and its routing limits. Missing pricing blocks the capped call. An uncertain
provider outcome retains the reservation until the period ends. Request quotas
remain active with or without spend caps.

Access records recipient consent and configures which actions require review.
Approvals lists simulated proposals and records the administrator’s decision.
Introductions require both recipients’ consent. Escalations require consent from
their recipient. See the deployment guide for optional Langfuse and Sentry setup.

Agent lifecycle is `shadow` (default), `paused`, `live` or `stopped` — administrator
only, audited. Live exists but stays gated until write adapters ship. Stop cancels
pending jobs where feasible. Runs move through queued → running → completed/failed/
interrupted. The most recent 50 runs are displayed with job status. Shared queue,
policy, budgets and runtime modules live under `apps/web/src/lib` and are imported by
`apps/worker`.

Validation: `bun run test:unit` on every `main` PR (auth/env, pure simulation helpers,
pictures, budgets, lifecycle, policy gateway and in-memory queue logic — no database).
PostgreSQL suites (`bun run test:queue`, `bun run test:simulation`,
`bun run test:integration`) and Playwright (`bun run test:e2e` after a production
build) run on the production release path or manual workflow dispatch — see
[testing policy](docs/testing/README.md). Runtime and persistence tests inject
deterministic inference; they do not spend API credit. Browser tests exercise admin
actions, lifecycle/budget controls, Access key-source states and persisted failure
details. Real provider quality requires a configured OpenRouter key (environment
default or per-agent) and a live manual test.

### Agent profile pictures

In **Configuration → Identity**, upload, replace or remove an agent’s picture.
JPEG, PNG and WebP up to 5 MB are accepted. Still images up to 32 megapixels are
centre-cropped to 512×512 WebP; original files and metadata are not retained.
Pictures save immediately without saving or clearing configuration edits. They
appear in the workspace and agent list, and do not enter model prompts or versioned
configuration snapshots.

RustFS stores pictures in a private bucket; PostgreSQL holds only the object key.
The local Compose service uses a named volume and loopback-only ports: API on 9000,
console on 9001. `.env.example` supplies local-only credentials. Run
`bun run storage:setup` after starting RustFS to create the bucket. Without storage
configuration, the rest of Orbit works and picture uploads show setup guidance.
See [deployment](docs/deployment.md) for private networking and production credentials.

Browser tests require the local RustFS service and a separate `orbit-test` bucket:

```sh
S3_BUCKET=orbit-test bun run storage:setup
```

They stop and restart the local Compose RustFS service to verify persistence and
storage-failure handling. Do not point this suite at a production storage service.
