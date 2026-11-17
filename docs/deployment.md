# Deployment

Set these variables on the web service:

| Variable               | Value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Target PostgreSQL connection URL.                                                  |
| `APP_URL`              | Public HTTPS origin. Loopback HTTP is allowed for local testing.                   |
| `ORBIT_ADMIN_EMAIL`    | Administrator login email.                                                         |
| `ORBIT_ADMIN_PASSWORD` | Random password of at least 16 characters.                                         |
| `AUTH_DISABLED`        | Leave unset or set to `false`. Local development bypass is rejected in production. |

Set `ORBIT_ENCRYPTION_KEY` to a random 64-character hex value before saving per-agent OpenRouter credentials. No channel credentials are needed for manual simulation. OAuth and magic links are deferred. Password sessions expire after eight hours; rotating the password invalidates existing sessions. Login allows ten account-wide attempts per fifteen minutes.

Before starting the web service, run `bun run db:migrate` from a source checkout against the target database. Migrations are transactional, advisory-locked and tracked in `orbit_migrations`; the standalone web image does not run them automatically.

Build the deployment images from the repository root:

```sh
docker build -f docker/web.Dockerfile -t orbit-web .
docker build -f docker/worker.Dockerfile -t orbit-worker .
```

The web image includes the self-hosted fonts, favicon and brand assets. `/health` checks the web process; authenticated pages require a working database. The worker currently starts and waits for shutdown; it has no agent execution loop yet.

If your package registry uses a private CA, pass its PEM file with `--secret id=npm_ca,src=/path/to/ca.pem` when building. The CA is mounted only for dependency installation and is not copied into the image. TLS verification remains enabled.

## RustFS profile-picture storage

Deploy `rustfs/rustfs:1.0.6` with a persistent volume at `/data` and
`RUSTFS_VOLUMES=/data`. Set `RUSTFS_ADDRESS=0.0.0.0:9000`,
`RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` to strong deployment credentials.
Use private networking between the web service and RustFS; do not expose the S3
API or admin console publicly without TLS and access controls. The Compose defaults
are for local development only. The console is optional in production.

Configure these server-only web variables:

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
service only needs GetObject, PutObject and DeleteObject on `agents/*` in that bucket;
HeadBucket/CreateBucket are needed only by the provisioning script.
Apply migration `0003` before deploying the web image. Pictures are served through
an authenticated Orbit route with private, non-cacheable responses. Storage secrets
never reach client props, prompts or application logs.

Back up and restore the RustFS data volume alongside PostgreSQL, preserving object
keys. Avoid `docker compose down -v` unless intentionally deleting local data.
Replacement/removal deletes the previous object after committing its new database
reference. Failed deletions produce an audit entry containing the object key for
manual cleanup. A process crash between object upload and database commit can leave
an unreferenced object; reconcile `agents/*/pictures/*` against `agents.picture_key`
before deleting orphans. No storage cleanup worker is scheduled in this milestone.
