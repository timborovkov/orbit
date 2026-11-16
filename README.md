![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

Orbit is a privately deployed control centre for persistent AI representatives. An administrator can configure agents with their own missions, tools, knowledge, credentials, schedules, budgets, and permissions, then inspect and control their activity.

Orbit runs a Next.js dashboard, a separate Bun worker, and PostgreSQL with pgvector. Docker and Railway provide deployment. See [architecture.md](architecture.md) for the product and architecture brief.

## Local start

Install [Bun](https://bun.sh/) 1.4.4 and Docker. Run `bun install` and `docker compose up -d postgres`, then `bun run dev` for the web app and worker. The dashboard is at `http://localhost:3000`.
