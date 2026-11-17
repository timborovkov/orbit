![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

A privately deployed control centre for persistent AI representatives, built with Next.js, Bun and PostgreSQL.

The console supports administrator login, template-based agents, versioned configurations, private profile pictures, and persisted manual simulations through OpenRouter. Schedules, channel integrations and live actions are deferred.

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

Set `ORBIT_ENCRYPTION_KEY` to a random 32-byte hex value (`openssl rand -hex 32`) in
the web service environment before saving credentials. Keep it outside PostgreSQL
and retain a secure backup across deployments; changing it makes existing encrypted
credentials unreadable. Replace or remove individual OpenRouter keys in the agent
workspace. Keys are AES-256-GCM encrypted with agent-bound authenticated data, never
returned to the browser, and never included in model prompts or diagnostic logs.
The application still starts without a master key, but credential operations cannot
succeed until it is configured.

Simulations make real, potentially billable OpenRouter inference calls: one evaluator
call and, only for relevant candidates, one main-model call. They have a two-minute
inference deadline, at most 3,000 output tokens per call, no automatic provider
retries, and one active run per agent. There are no external action adapters or
write tools in this path. Every proposal is persisted as suppressed, regardless of
global pause or future live settings. Missing credentials and inference failures
produce inspectable failed runs; provider error bodies are deliberately discarded.
Token usage is shown when returned; monetary cost is not estimated.

Runs save the input and immutable configuration version before inference, then
checkpoint each completed stage. Expired in-flight runs display as interrupted;
a new attempt records a new run, preserving earlier results. There is no background
resume or schedule in this milestone. The most recent 50 runs are displayed.
Framework-independent execution, schemas, encryption and OpenRouter inference live
in `apps/web/src/lib/runtime`; the persistence service has no Next.js dependency and
can be invoked by the Bun worker with an authenticated job context later. Nothing
starts autonomous work yet.

Validation: `bun run test:unit`, `bun run test:simulation` (requires migrated
`orbit_test` PostgreSQL), and `bun run test:e2e` after a production build. Runtime
and persistence tests inject deterministic inference; they do not spend API credit.
Browser tests exercise real admin actions, template/configuration edits, encryption,
and persisted failure details. Real provider quality requires an administrator's
OpenRouter key and a live manual test.

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
