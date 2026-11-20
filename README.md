![Orbit logo](assets/brand/orbit-luminous.svg)

# Orbit

A privately deployed control centre for persistent AI representatives, built with Next.js, Bun and PostgreSQL.

## Setup

Install Bun canary (1.4.6+, see `.bun-version`) and Docker. Copy [`.env.example`](.env.example) to `.env` and fill in the values.

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres rustfs
bun run db:migrate
bun run db:seed:demo
bun run storage:setup
bun run dev
```

Open http://localhost:3000.

## Checks

```sh
bun run validate
bun run test:unit
bun run test:simulation
bun run test:e2e
```

Simulation and e2e need extra local setup; see [testing](docs/testing/README.md).

## Docs

- [Architecture](architecture.md)
- [Design](design.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Contributing](CONTRIBUTING.md)
