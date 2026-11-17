# Testing

Executable commands live in [package.json](../../package.json). CI results are the
evidence for a particular revision, not a permanent prose inventory.

## Validation policy

Scope verification to the behavior and risk of the change. GitHub Actions owns
repo-wide validation; do not routinely duplicate it locally.

- **Application code, executable scripts, or generated behavior:** run the nearest
  targeted local tests for the behavior changed. Broaden only when the affected
  boundary or a failure justifies it.
- **CI-only changes that do not alter application code or test behavior:** inspect
  workflow syntax, triggers, conditions, and required-check names, then verify the
  affected GitHub run. Do not run local application suites, repo-wide validation,
  or React Doctor merely because workflow YAML is executable configuration.
- **Prose-only docs and agent instructions:** review the diff, changed-file
  formatting, links, and consistency. No application tests or repo-wide checks.
- Run repo-wide local validation or full suites only when explicitly requested,
  or when a concrete investigation requires them; state the reason first. Prefer
  GitHub for broad verification.

### GitHub checks and merge gates

- Commits, pushes, and opening PRs are allowed before CI passes; that is how CI
  runs. Required GitHub checks gate **merging**, not opening a PR.
- Do not merge while required checks are pending or failing, bypass protections,
  or weaken checks to obtain a pass.
- Report targeted checks and GitHub status accurately. Pending checks must be
  called out.
- Fix failures caused by the change, then rerun the affected checks. Report
  unrelated failures separately with evidence.
- GitHub's static gate runs `bun run validate` (Prettier, TypeScript, ESLint,
  Knip, React Doctor), `bun run build`, and `bun run test:unit`. React Doctor must
  show score 100 and no issues; an exit without a score is not proof of 100.

## Branch and release CI

```text
PR → main:        Static checks
PR → production:  Static checks + Full validation + PostgreSQL integration + Playwright E2E
production push:  same as production PR
workflow_dispatch CI:  Static checks + Full validation + PostgreSQL integration
workflow_dispatch E2E: Playwright E2E (any branch)
```

- `main` is the development branch. PRs require only `Static checks`: validation,
  React Doctor, web build, and fast unit tests (no database, browsers, Docker image
  builds, or RustFS).
- `production` is the release branch. PRs require `Static checks`,
  `Full validation` (Docker image builds and container smoke tests),
  `PostgreSQL integration` (migrated `orbit_test` and simulation persistence), and
  `Playwright E2E`, with an up-to-date branch and resolved review threads. Release
  through a PR from `main` to `production`.
- Heavy CI jobs also run on production pushes and on manual `CI` workflow
  dispatch. Superseded PR runs are cancelled.
- Browser E2E runs on production PRs/pushes and on manual `E2E` workflow dispatch.
  Unlike The Timeline (manual-only E2E), Orbit keeps Playwright in the production
  release path. It never runs on `main` PRs.
- A job skipped by an `if:` still satisfies a required check of that name (GitHub
  treats skipped as passing). Do not rename required check names without updating
  branch protection.

### Recommended required checks (manual branch protection)

| Branch       | Required status checks                                                         |
| ------------ | ------------------------------------------------------------------------------ |
| `main`       | `Static checks`                                                                |
| `production` | `Static checks`, `Full validation`, `PostgreSQL integration`, `Playwright E2E` |

Also enforce an up-to-date branch and resolved conversation threads on `production`.
Do not change branch protection from automation; an operator applies these by hand.

### Job rename note

`PostgreSQL and browser integration` was split into `PostgreSQL integration` (CI)
and `Playwright E2E` (E2E workflow). Replace the old required-check name wherever it
is still configured.

## Local commands

Fast path (matches `Static checks`):

```sh
bun run validate
bun run build
bun run test:unit
```

Heavy suite (matches production-gated CI and E2E):

```sh
# Docker image builds and smoke (Full validation)
docker build -f docker/web.Dockerfile -t orbit-web:ci .
docker build -f docker/worker.Dockerfile -t orbit-worker:ci .

# PostgreSQL integration
docker compose exec postgres createdb -U orbit orbit_test
DATABASE_URL=postgres://orbit:orbit_dev@localhost:5432/orbit_test bun run db:migrate
bun run test:simulation

# Playwright E2E (see docs/development.md for RustFS and disposable DB setup)
bunx playwright install chromium
bun run test:e2e
```

To run the heavy GitHub jobs without a production PR, use **Actions → CI → Run
workflow** and **Actions → E2E → Run workflow** on the target branch.

Use Bun only. Do not use `pnpm`, `npm`, or `yarn`.

## Change-specific verification

These checks apply when the named behavior changes, not to unrelated docs or CI
routing edits.

- Run `bun run test:unit` when auth/env parsing, simulation runtime logic without
  persistence, or picture helpers change.
- Run `bun run test:simulation` when simulation persistence, isolation, or shared
  runtime execution changes (requires migrated `orbit_test`).
- Run `bun run test:e2e` after a production build when UI flows, auth sessions,
  accessibility, or profile-picture storage change (requires `orbit_test` and
  RustFS for picture tests).
