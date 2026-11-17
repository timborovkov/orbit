# Contributing

Orbit is in early development. Read [architecture.md](architecture.md) and [AGENTS.md](AGENTS.md) before changing behavior. For substantial external contributions, open a proposal issue and agree on scope with a maintainer before writing a pull request. Do not put credentials or private data in issues, code, or logs.

The repository uses Bun 1.4.4. Run `bun install`, then `bun run validate` before opening a pull request. Validation checks formatting, types, lint, unused code, and a React Doctor score of 100. `main` is the development branch (Railway deploys from it for now). On PRs to `main`, CI requires `Static checks` (`validate`, web build, and fast unit tests). Releases go through a PR from `main` to protected `production`, where Docker image builds, PostgreSQL simulation, and Playwright E2E run — also on production pushes and manual workflow dispatch. See [testing policy](docs/testing/README.md).

Use `<owner>/<type>/<description>` for branches, with a short kebab-case description and a type such as `feat`, `fix`, `docs`, or `chore`. Pull request titles use `<type>: <clear outcome>`. Keep the description focused on the change and checks run. Do not merge around required GitHub checks or unresolved review threads.

Report security issues through [GitHub private vulnerability reporting](SECURITY.md) instead of opening a public issue. Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or [feature proposal](.github/ISSUE_TEMPLATE/contribution_proposal.yml) form for non-sensitive issues. Before marking a PR ready, record a review of the current diff and address actionable findings; new commits need another review.
