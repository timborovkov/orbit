![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

A privately deployed control centre for persistent AI representatives, built with Next.js, Bun and PostgreSQL.

The initial console supports administrator password login, paused agent creation, global outbound pause and audit history. Agent execution and provider connections are still upcoming.

## Start locally

Install Bun 1.4.4 and Docker. Copy `.env.example` to `.env` and replace the administrator email and password (at least 16 characters).

```sh
bun install --frozen-lockfile
docker compose up -d postgres
bun run db:migrate
bun run dev
```

Open http://localhost:3000.

- [Development and testing](docs/development.md), including local development without login.
- [Deployment and environment variables](docs/deployment.md).
- [Architecture](architecture.md), [design](design.md) and [contributing](CONTRIBUTING.md).
