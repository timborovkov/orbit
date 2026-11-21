# Deployment

Set these variables on the web service:

| Variable               | Value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Target PostgreSQL connection URL.                                                  |
| `APP_URL`              | Public HTTPS origin. Loopback HTTP is allowed for local testing.                   |
| `ORBIT_ADMIN_EMAIL`    | Administrator login email.                                                         |
| `ORBIT_ADMIN_PASSWORD` | Random password of at least 16 characters.                                         |
| `AUTH_DISABLED`        | Leave unset or set to `false`. Local development bypass is rejected in production. |
| `OPENROUTER_API_KEY`   | Optional. Default OpenRouter key for agents without a per-agent override.          |
| `ORBIT_ENCRYPTION_KEY` | Optional until you save per-agent keys. Random 64-character hex master key.        |

Set `OPENROUTER_API_KEY` when you want a deployment-wide OpenRouter default; agents may still store an encrypted override under **Access**. Set `ORBIT_ENCRYPTION_KEY` before saving those per-agent credentials. The environment default works without an encryption key because it is never written to PostgreSQL. Deploy the web and worker together so both pick up the same schema; migrations apply automatically. No channel credentials are needed for manual simulation. OAuth and magic links are deferred. Password sessions expire after eight hours; rotating the password invalidates existing sessions. Login allows ten account-wide attempts per fifteen minutes.

Railway runs `scripts/migrate.ts` as `preDeployCommand` on web and worker, and again at process start (web via `scripts/start-web.ts`, worker before queues). Migrations are transactional, advisory-locked (`pg_advisory_xact_lock(712604)`) and tracked in `orbit_migrations`, so overlapping deploys and restarts stay safe. Local development still uses `bun run db:migrate` against Compose Postgres.

Build the deployment images from the repository root:

```sh
docker build -f docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="$NEXT_PUBLIC_SENTRY_DSN" \
  --build-arg NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE="$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE" \
  -t orbit-web .
docker build -f docker/worker.Dockerfile -t orbit-worker .
```

`NEXT_PUBLIC_SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` are inlined into the browser bundle at image build. Unset, browser Sentry stays off. Setting them only on the running web container cannot enable capture. Compose forwards them from the host env as web build args. Railway injects matching service variables because the Dockerfile declares those `ARG` names. Server-side Sentry still uses runtime `SENTRY_DSN` on web and worker.

The web image includes the self-hosted fonts, favicon and brand assets. `/health` checks the web process; authenticated pages require a working database. The worker claims simulation and knowledge-processing jobs, heartbeats leases, recovers expired claims, and drains in-flight work on SIGTERM. Set the same `DATABASE_URL`, optional `ORBIT_ENCRYPTION_KEY` and optional `OPENROUTER_API_KEY` on the worker as on the web service.

The Dockerfiles use the base image's trust store for dependency installation. Railway's Docker builder does not support BuildKit secret mounts.

Production web builds use webpack. The web image installs locked production dependencies in its runtime stage so server instrumentation is available when the standalone server starts.

## RustFS object storage

Deploy `rustfs/rustfs:1.0.6` with a persistent volume at `/data` and
`RUSTFS_VOLUMES=/data`. Set `RUSTFS_ADDRESS=0.0.0.0:9000`,
`RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` to strong deployment credentials.
Use private networking between both application services and RustFS; do not expose the S3
API or admin console publicly without TLS and access controls. The Compose defaults
are for local development only. The console is optional in production.

Configure these server-only variables on the Railway web and worker services:

| Variable               | Purpose                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`          | RustFS S3 API URL, such as `http://rustfs:9000` on a private network; HTTPS when crossing public networks. |
| `S3_REGION`            | `us-east-1` by default.                                                                                    |
| `S3_BUCKET`            | Private bucket name, e.g. `orbit`.                                                                         |
| `S3_ACCESS_KEY_ID`     | RustFS access key; use a dedicated application identity in production.                                     |
| `S3_SECRET_ACCESS_KEY` | Matching secret, supplied through deployment secrets.                                                      |

From a trusted source checkout with provisioning credentials, run
`bun run storage:setup` once. It creates a private bucket if absent; it does not
change existing bucket policies. Keep anonymous access disabled. The running web
service needs GetObject, PutObject and DeleteObject on `agents/*`. The worker only needs
GetObject on `agents/*/knowledge/*`. HeadBucket/CreateBucket are needed only by the
provisioning script. Migrations apply on deploy/start for both services. If overriding
`KNOWLEDGE_EMBEDDING_MODEL`, set the same value on both services and reprocess existing
documents. The configured vector width must be 1536.
Pictures are served through
an authenticated Orbit route with private, non-cacheable responses. Storage secrets
never reach client props, prompts or application logs.

Back up and restore the RustFS data volume alongside PostgreSQL, preserving object
keys. Avoid `docker compose down -v` unless intentionally deleting local data.
Replacement/removal deletes the previous object after committing its new database
reference. Failed deletions produce an audit entry containing the object key for
manual cleanup. A process crash between object upload and database commit can leave
an unreferenced object; reconcile `agents/*/pictures/*` against `agents.picture_key`
and `agents/*/knowledge/*` against `knowledge_documents.object_key` before deleting orphans.

## Runtime telemetry

Observability is optional. The variables, including sample rates and prompt
capture, are listed in [`.env.example`](../.env.example). Unset, the web app and
worker make no exporter network calls.

Create one Sentry project (web and worker can share it) and one Langfuse
project, plus an optional development Langfuse project — not a project per
agent. Browser capture needs `NEXT_PUBLIC_SENTRY_DSN` at web image build, as
above. Source map upload needs `SENTRY_AUTH_TOKEN` and is skipped without it.
See [architecture.md](../architecture.md) §12 and the Phase 2 observability
decision for tracing behaviour, redaction and evaluations.

## Email (inbound and approved outbound replies)

Inbound and outbound email schema lives in `apps/web/drizzle/0014_inbound_email.sql`
and `apps/web/drizzle/0015_outbound_email.sql`; Railway applies pending migrations on
deploy and startup. Deploy the worker with `RESEND_API_KEY` for the Resend Receiving API
and outbound sends, then deploy the web service with `RESEND_INBOUND_DOMAIN` and
`RESEND_WEBHOOK_SECRET`. Optional `RESEND_SENDING_DOMAIN` on the worker constrains
From addresses to that verified domain. All of these variables are optional for
deployments without email. The API key belongs on the worker only.

In Resend, enable receiving for a dedicated subdomain and verify the MX record shown
for that domain. Verify the same domain (or a dedicated sending domain) for outbound
mail. Create a webhook for `email.received` at
`https://<app-host>/api/webhooks/resend` and use that webhook’s signing secret.
Turn on delivery after the worker and web service are ready (migrations already ran
on deploy/start). Store credentials as runtime secrets. Old mailbox addresses keep
their original domain if the environment value changes, so keep receiving configured
for those addresses.

Enable email for Sarah in Orbit and send a message and a reply to the displayed
address. Check the Email tab for a single thread, local drafts, citations when
knowledge supports the response, and terminal run statuses. Outbound replies require
Live lifecycle, released global pause, administrator approval, and an enabled mailbox;
Shadow stays draft-only. Enable other agents after the smoke test passes. Fixture
tests stub Resend retrieval, inference, and sending. Staged smoke tests can verify
real delivery when keys are present.

For rollback, disable webhook delivery first. Drain pending email drafts and
`email.send` jobs or pause the email-enabled agents. Keep the additive migrations
and the stored mail. Older worker builds ignore unknown job types.
