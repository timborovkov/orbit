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

Set `OPENROUTER_API_KEY` when you want a deployment-wide OpenRouter default; agents may still store an encrypted override under **Access**. Set `ORBIT_ENCRYPTION_KEY` before saving those per-agent credentials. The environment default works without an encryption key because it is never written to PostgreSQL. Apply all pending migrations before deploying the web and worker together. No channel credentials are needed for manual simulation. OAuth and magic links are deferred. Password sessions expire after eight hours; rotating the password invalidates existing sessions. Login allows ten account-wide attempts per fifteen minutes.

Before starting the web service, run `bun run db:migrate` from a source checkout against the target database. Migrations are transactional, advisory-locked and tracked in `orbit_migrations`; the standalone web image does not run them automatically.

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

If your package registry uses a private CA, pass its PEM file with `--secret id=npm_ca,src=/path/to/ca.pem` when building. The CA is mounted only for dependency installation and is not copied into the image. TLS verification remains enabled.

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
provisioning script. Apply migrations before deploying both services. If overriding
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
