## Change

<!-- Briefly describe the problem and resulting behavior. Link the agreed issue
for an external contribution. Add risks or rollout steps only when relevant. -->

## Verification

<!-- List commands and results, or why checks are not needed. Before marking ready,
include the reviewed commit and a review link or local result. Resolve actionable findings.

CI reminder (see docs/testing/README.md):
- main is development (Railway deploys from main for now); production is the release branch.
- PRs to main: Static checks only (validate, build, test:unit).
- Release via PR main → production: also Full validation, PostgreSQL integration, and Playwright E2E.
- Heavy suites: run locally, or Actions → CI / E2E → Run workflow. -->
