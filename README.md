![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

Orbit is a privately deployed control centre for persistent AI representatives. An administrator can configure agents with their own missions, tools, knowledge, credentials, schedules, budgets, and permissions, then inspect and control their activity.

Orbit runs a Next.js dashboard, a separate Bun worker, and PostgreSQL with pgvector. Docker and Railway provide deployment. See [architecture.md](architecture.md) for the product and architecture brief.

## Local start

Install [Bun](https://bun.sh/) 1.4.4 and Docker. Run `bun install` and `docker compose up -d postgres`, then `bun run dev` for the web app and worker. The dashboard is at `http://localhost:3000`.

## Initial control centre

Use Bun 1.4.4. Copy `.env.example` to `.env`, replace the administrator email
and password (at least 16 random characters), then run:

```sh
bun install --frozen-lockfile
docker compose up -d postgres
bun run db:migrate
bun run dev
```

Open http://localhost:3000. The initial console supports password login,
agent creation (paused, shadow mode), a persisted global outbound pause,
and audit history. Runtime activation and provider connections are upcoming.
Rotate the environment password to invalidate sessions. Session expiry is eight
hours; ten account-wide login attempts are allowed per fifteen minutes.

For deployment, set `DATABASE_URL`, `APP_URL` (HTTPS), `ORBIT_ADMIN_EMAIL` and
`ORBIT_ADMIN_PASSWORD` on the web service. Run `bun run db:migrate` from the
source checkout against the target database before starting the web service.
Migrations are transactional, advisory-locked and tracked in `orbit_migrations`.
The standalone web image contains the public brand assets; it does not run
migrations automatically. No external AI or channel credentials are needed yet.

Validation: `bun run check`, `bun run build`, then `bunx playwright install chromium`
and `bun run test:e2e`. E2E tests require the local Compose PostgreSQL database
in a dedicated `orbit_test` database and **truncate its foundation tables**. Create it with
`docker compose exec postgres createdb -U orbit orbit_test`, then run
`DATABASE_URL=postgres://orbit:orbit_dev@localhost:5432/orbit_test bun run db:migrate`.
The development `orbit` database is not used by the tests. They
run the production web build and verify login, session protection, throttling,
database persistence, themes, mobile overflow, controls and logout.

The interface follows the Vercel-inspired direction in `design.md`: locally
bundled Geist, neutral light/dark themes, compact agent tables, and a keyboard
accessible create-agent dialog. Integration tests also run axe accessibility
checks at 1440, 1024, 768, 390 and 320 pixels in both themes. Dashboard, sign-in
and dialog screenshots are written to the ignored `test-results/` directory.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium installation.

## Local development without login

Use this only with a local PostgreSQL database and the guarded development command:

```dotenv
AUTH_DISABLED=true
AUTH_LOCAL_ADMIN_EMAIL=local-admin@example.test
APP_URL=http://127.0.0.1:3000
DATABASE_URL=postgres://orbit:orbit_dev@127.0.0.1:5432/orbit
```

Run `bun run dev`, then open the exact `APP_URL`. The web development launcher binds
only to `127.0.0.1`; set `PORT` if you need a different port and update `APP_URL` to
match. It does not accept server flags. Do not proxy or tunnel this bypass server.
`ORBIT_LOCAL_DEV_SERVER` is an internal launcher marker, not a variable to set manually.

`AUTH_DISABLED` defaults to `false` and accepts only the exact strings `true` or
`false`. When enabled, it requires `NODE_ENV=development`, the guarded launcher,
loopback app and database URLs, and a valid explicit `AUTH_LOCAL_ADMIN_EMAIL`.
It fails startup in production. Administrator password credentials are unnecessary
only in this mode. `/login` redirects to the dashboard, no session cookie is created,
and a persistent notice identifies the bypass and its audit identity. Mutations
still validate their origin and write real database/audit records. The sign-out
control is hidden because there is no session to end.

Set `AUTH_DISABLED=false` (or remove it) and restart to restore password login;
`ORBIT_ADMIN_EMAIL` and `ORBIT_ADMIN_PASSWORD` are then required. Keep authentication
enabled on Railway. OAuth and magic links remain planned additions.

After `bun run build`, run `bun run test:unit` to check the configuration matrix
and actual production startup refusal. `bun run test:e2e` runs the production
password-login suite followed by a local-development bypass suite, both against
the disposable `orbit_test` PostgreSQL database.
