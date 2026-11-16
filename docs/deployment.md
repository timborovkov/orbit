# Deployment

Set these variables on the web service:

| Variable               | Value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`         | Target PostgreSQL connection URL.                                                  |
| `APP_URL`              | Public HTTPS origin. Loopback HTTP is allowed for local testing.                   |
| `ORBIT_ADMIN_EMAIL`    | Administrator login email.                                                         |
| `ORBIT_ADMIN_PASSWORD` | Random password of at least 16 characters.                                         |
| `AUTH_DISABLED`        | Leave unset or set to `false`. Local development bypass is rejected in production. |

No AI or channel credentials are needed for the initial console. OAuth and magic links are deferred. Password sessions expire after eight hours; rotating the password invalidates existing sessions. Login allows ten account-wide attempts per fifteen minutes.

Before starting the web service, run `bun run db:migrate` from a source checkout against the target database. Migrations are transactional, advisory-locked and tracked in `orbit_migrations`; the standalone web image does not run them automatically.

Build the deployment images from the repository root:

```sh
docker build -f docker/web.Dockerfile -t orbit-web .
docker build -f docker/worker.Dockerfile -t orbit-worker .
```

The web image includes the self-hosted fonts, favicon and brand assets. `/health` checks the web process; authenticated pages require a working database. The worker currently starts and waits for shutdown; it has no agent execution loop yet.

If your package registry uses a private CA, pass its PEM file with `--secret id=npm_ca,src=/path/to/ca.pem` when building. The CA is mounted only for dependency installation and is not copied into the image. TLS verification remains enabled.
