# Development and testing

Use Bun 1.4.4. Follow the [README setup](../README.md) for the local PostgreSQL database and application.

## Local development without login

Set these values in `.env`:

```dotenv
AUTH_DISABLED=true
AUTH_LOCAL_ADMIN_EMAIL=local-admin@example.test
APP_URL=http://127.0.0.1:3000
DATABASE_URL=postgres://orbit:orbit_dev@127.0.0.1:5432/orbit
```

Run `bun run dev` and open the exact `APP_URL`. The guarded launcher binds to `127.0.0.1`; set `PORT` and update `APP_URL` together to change the port. It accepts no server flags. Do not proxy or tunnel this server.

Bypass requires `NODE_ENV=development`, loopback app and database URLs, and an explicit local email. The launcher supplies the internal `ORBIT_LOCAL_DEV_SERVER` marker; do not set it manually. A localhost app URL alone cannot prove that the listener is bound locally. Production startup rejects bypass.

No password or session is used in this mode. The dashboard displays the local identity, validates mutation origins and writes real audit records. Set `AUTH_DISABLED=false` (the default) and restart to restore password login.

## Checks

`main` is development (Railway deploys from it for now); `production` is the
protected release branch via a PR from `main`, where heavy CI runs. Which suites
run where, and how to trigger the heavy path manually, is owned by
[testing policy](testing/README.md).

Fast path (every `main` PR — `Static checks`):

```sh
bun run validate
bun run build
bun run test:unit
```

Validation includes formatting/import order, types, strict lint, unused code and React Doctor 100. Application imports use `@/*`; Prettier sorts imports automatically. Fast unit tests need no database.

Heavy suites (production PRs/pushes, or manual workflow dispatch): Docker image
builds and smoke (`Full validation`), migrated `orbit_test` simulation
(`PostgreSQL integration`), and Playwright (`Playwright E2E`). Prefer GitHub for
those unless iterating locally.

Browser tests use a **disposable `orbit_test` database and truncate its foundation tables**. They do not use the development `orbit` database:

```sh
docker compose exec postgres createdb -U orbit orbit_test
DATABASE_URL=postgres://orbit:orbit_dev@localhost:5432/orbit_test bun run db:migrate
docker compose up -d --wait rustfs
S3_BUCKET=orbit-test bun run storage:setup
bunx playwright install chromium
bun run test:e2e
```

The production-build suite checks password login, session revocation, throttling, PostgreSQL persistence, controls, themes and accessibility at five viewport widths. A separate OpenRouter environment-default suite starts the built app with `OPENROUTER_API_KEY` and checks Access tab source states. The development suite checks cookie-free local bypass and audit identity. Screenshots and failure evidence are written to ignored `test-results/`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium installation.

The profile-picture browser test uses the local Compose RustFS instance, stopping and starting it to verify storage failure handling and durable images. It requires the local-only storage credentials in `.env.example`; it never uses a remote bucket. Do not run PostgreSQL-mutating suites concurrently.
