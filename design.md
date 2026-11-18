---
name: Orbit
description: A focused administration console for independent AI agents.
colors:
  bg: '#fafafa'
  surface: '#fff'
  subtle: '#f5f5f5'
  ink: '#171717'
  muted: '#666'
  faint: '#6b6b6b'
  border: '#e5e5e5'
  strong-border: '#d4d4d4'
  control-border: '#888'
  button: '#171717'
  button-ink: '#fff'
  hover: '#f0f0f0'
  focus: '#0070f3'
  danger: '#b42318'
  danger-bg: '#fff5f4'
  bg-dark: '#0a0a0a'
  surface-dark: '#0a0a0a'
  subtle-dark: '#111'
  ink-dark: '#ededed'
  muted-dark: '#a1a1a1'
  faint-dark: '#888'
  border-dark: '#292929'
  strong-border-dark: '#444'
  control-border-dark: '#777'
  button-dark: '#ededed'
  button-ink-dark: '#0a0a0a'
  hover-dark: '#1a1a1a'
  focus-dark: '#52a8ff'
  danger-dark: '#ff8a80'
  danger-bg-dark: '#251211'
  workspace-accent: '#563cc7'
  workspace-selection: '#f1edfc'
  workspace-accent-dark: '#baa9ff'
  workspace-selection-dark: '#241f35'
typography:
  headline:
    fontFamily: 'IBM Plex Sans Variable, Arial, sans-serif'
    fontSize: '1.5rem'
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: '-0.025em'
  title:
    fontFamily: 'IBM Plex Sans Variable, Arial, sans-serif'
    fontSize: '1rem'
    fontWeight: 600
    letterSpacing: '-0.015em'
  body:
    fontFamily: 'IBM Plex Sans Variable, Arial, sans-serif'
    fontSize: '0.875rem'
    lineHeight: 1.5
  label:
    fontFamily: 'IBM Plex Sans Variable, Arial, sans-serif'
    fontSize: '0.8125rem'
    fontWeight: 500
  metadata:
    fontFamily: 'IBM Plex Mono, monospace'
    fontSize: '0.75rem'
    fontWeight: 400
rounded:
  control: '6px'
  panel: '8px'
  tag: '5px'
spacing:
  small: '8px'
  medium: '16px'
  large: '24px'
  editor: '32px'
components:
  button-primary:
    backgroundColor: '{colors.button}'
    textColor: '{colors.button-ink}'
    rounded: '{rounded.control}'
    height: '36px'
    padding: '0 13px'
  button-outline:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.muted}'
    rounded: '{rounded.control}'
  button-destructive:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.danger}'
    rounded: '{rounded.control}'
  workspace-input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '10px 12px'
  workspace-tab:
    backgroundColor: 'transparent'
    textColor: '{colors.muted}'
    padding: '12px 2px'
  state-label:
    textColor: '{colors.muted}'
    rounded: '{rounded.tag}'
    padding: '3px 8px'
  configuration-workbench:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.panel}'
---

# Orbit design foundation

## Overview

**Creative North Star: "Vercel-inspired administration UI"**

Vercel-inspired administration UI: neutral surfaces, crisp one-pixel borders, restrained density and clear type. The product opens on its operational content. No promotional hero, decorative gradients or invented metrics. The supplied luminous orbital logo retains its original colour in the header and favicon; its violet/cyan illumination is a brand signature, not a wash over every surface.

Taste Skill 2.5.1 informs plain copy, consistent spacing, alignment, keyboard access and browser review. Its marketing-site rules (full-screen sections, hero animation, random layout deals, static exports) do not apply to an authenticated server-rendered control centre. The user selected the Vercel-inspired direction explicitly.

**Key Characteristics:**

- Neutral surfaces with crisp one-pixel boundaries.
- Operational content and explicit state before decoration.
- Original Orbit emblem, self-hosted IBM Plex typography and responsive themes.

## Colors

Primary actions reverse the neutral foreground/background pair. The workspace accent
is restrained violet: selected section text/fill, active task underline, text caret
and precise-pointer link hover. Selection fill uses the workspace-selection token.
Blue is reserved for visible keyboard focus. Red marks errors and destructive actions;
the reversible global pause remains neutral. Status always includes text.

Neutral tokens distinguish canvas, surface, subtle area, readable secondary text,
separators and stronger control boundaries. The frontmatter records light tokens and
their `-dark` counterparts; Auto resolves to the operating-system preference.
The supplied logo retains its own violet/cyan illumination rather than recolouring
surfaces. Control boundaries use their dedicated token, independently of separators.

## Typography

IBM Plex Sans Variable (Arial, sans-serif fallback) is self-hosted throughout. IBM
Plex Mono (monospace fallback), weight 400, is limited to activity timestamps and
small counts. The user rejected Geist as overused. Typography gains character through
letterforms rather than display decoration. Page headings use the headline role;
workspace editor/result headings use title. Ordinary sections remain 0.875rem/600,
row titles and labels 0.8125rem/500. Metadata is at least 0.75rem. Narrow page headings
use 1.375rem; mobile workspace fields use 1rem to avoid focus zoom. Rem units preserve
browser text enlargement. Editor explanatory copy stays within 68ch.

## Layout

The main container is capped at 1280px with 40px desktop and 16px phone gutters.
Spacing follows a mostly 4px rhythm. The workspace header is at least 64px tall;
main content starts with 36px top padding, reduced to 24px below 600px. The configuration
editor uses a 192px section navigator (156px below 900px) and a flexible field area;
below 600px the navigator becomes a horizontal row and identity fields stack.
Playground uses 0.9fr/1.1fr composer/result columns; history uses a flexible run list
and 280px version column. Both become single-column below 900px. Task tabs can scroll
horizontally on narrow screens. Overview-specific responsive behavior remains below.

A compact identity header sits above workspace tabs. The overview contains three database-derived agent counts, an agent table, recent audit activity and a global outbound control. The sidebar and decorative statistic cards have been removed. At tablet widths, activity stacks below the agent area; at phone widths, controls stack and names wrap within the table. Missions appear directly beneath agent names as muted, wrapping text. Show the full value without a disclosure, repeated “View mission” controls or hover-only access. Preserve line breaks and allow long words to wrap.

Create agent opens a native modal dialog with a visible title, field labels, initial focus, an inert background, native dialog tab behaviour, Escape/cancel behaviour, pending feedback, explicit required indicators, and field-specific server validation linked through aria-describedby/aria-invalid. Pending text fields are read-only so focus can return to a validation error. Failed requests retain entries and name a recovery action. Success closes the dialog only after the server action completes. Agents start paused in shadow mode; the UI explains that execution is not yet configured.

Sign-in is a centred 400px form panel with one primary action, the supplied 64px orbital emblem, and a 24px heading. The form uses 44px-high inputs and submit action; a keyboard-accessible eye button reveals or hides the password without submitting the form or changing its value. Appearance uses a compact three-segment native radio control: sun (Light), moon (Dark), and monitor (Auto). The selected segment has a visible border and surface treatment. One tab stop and native arrow-key navigation change selection; touch targets grow to 44px. Preference persists locally and applies before paint; Auto tracks OS preference changes, and the browser theme-color follows the resolved appearance. There is no public registration. A skip link, explicit navigation labels, semantic table headers and visible focus rings support keyboard and assistive technology use.

## Elevation & Depth

Surfaces rely primarily on borders and tonal separation. Inputs retain a subtle
`0 1px 2px #00000005` shadow, selected appearance segments `0 1px 2px #00000008`,
and the native create dialog `0 16px 64px #00000020`. Its backdrop is `#0007` with
2px blur. These are local roles, not permission to add shadows to every panel.

## Shapes

Controls use 6px corners, panels 8px, state labels 5px, and dialog/login shells 10px.
The workspace monogram uses 12px corners. One-pixel boundaries distinguish areas;
the active workspace tab adds a two-pixel underline. Workspace rows stay flat until
an expanded template reveals its bordered editor.

## Components

Buttons share the Slot/CVA primary, outline, ghost and destructive variants. Standard
height is 36px with 0 13px padding; workspace save controls are at least 40px, login
and key mobile controls at least 44px. Fine-pointer hover is capability-gated.
Pointer press uses scale(0.97) over 150ms with cubic-bezier(0.23, 1, 0.32, 1);
keyboard activation and reduced-motion remain immediate. Theme colours switch
instantly. Focus uses a two-pixel focus-token outline with three-pixel offset.

Workspace fields use visible labels, required indicators and the dedicated control
border. The shared form shows pending feedback, errors and optional saved/unsaved
status. Its save bar is separated by a top border and subtle fill. Identity,
Behaviour and Models section buttons show one field group at a time; hidden fields
remain mounted. Invalid required fields reveal their section before receiving focus.

Task tabs are Configuration, Playground, Knowledge, History, Approvals and Access. On
viewports wider than 600px they use a horizontal tablist with Left/Right/Home/End
keyboard navigation; at 600px and below they collapse to a full-width Select (same
pattern as the UI redesign branch). Hidden panels remain mounted, preserving
unsaved configuration and pasted input when changing tasks. Configuration presents
one editor and one save bar. Playground places a composer beside the latest persisted
result and explicitly names paid inference and suppressed external actions. Empty
results explain what will appear; failures and interrupted runs show actual state.
Knowledge is list-first: the document library leads with a header Upload control and,
when empty, a dashed dropzone (“Drop files or browse”, accepted types, 10 MB limit).
Rows show title + status Badge, then a muted sans meta line (type, size, chunk count,
relative “Updated …” with full UTC in a tooltip). Row actions live in an ellipsis
DropdownMenu; Delete confirms via AlertDialog. Failed rows surface the error with
Retry. The retrieval inspector uses a single-line InputGroup with an adjacent Inspect
control; results open with a “Found N passages” header (plus a “Dev stub embeddings”
Badge when the stub embedder is active). Each hit shows title, rank, combined score
and vector/text score Badges, with raw offsets/reasons behind a Details collapsible.
Wide layouts place the inspector beside the list; below 900px they stack.
History uses native details/summary for run content and exact configuration snapshots.
History shows the provider’s recorded cost and labels missing cost explicitly.
Access stacks lifecycle, budget, approval requirements, recipient consent and
OpenRouter connection settings in one column. Daily and monthly spend limits use
numeric fields paired with independently labelled No cap checkboxes. Consent
records pair a recipient ID with a scope, choice and evidence reference. Playground
accepts the same IDs for consent checks in an optional disclosure. Approvals shows
the pending queue first, with the draft and explicit approve and reject controls.
Lifecycle options show the current state and clearly label Live as simulation-only
until adapters are configured. Access also shows which OpenRouter key source is active—agent key, environment
default or none—by label only, never by value or prefix. It accepts a password input
for an agent override, clears it after submission and never reads the secret back.
Removing an agent key falls back to the environment default when configured; otherwise
it retains a visible missing-key state. History shows queued/running/completed/failed/
interrupted run states and linked job status. While any run is queued or running, or any
knowledge document is pending/processing, the workspace soft-refreshes every two seconds
so Playground, History and Knowledge pick up worker results without a manual reload.
No loading skeletons on Access.

Templates are flat disclosure rows with title, role and revision. Expanding a row
uses the same section editor and save bar; saving defaults leaves existing agents
unchanged. Appearance, sign-in and the native create dialog retain the behavior in
Layout and the historical decisions below.

## Do's and Don'ts

- Do preserve the original Orbit logo, IBM Plex fonts and Light/Dark/Auto appearance.
- Do keep status explicit in text and retain user input through recoverable errors.
- Do verify both themes, keyboard behavior and narrow layouts after UI changes.
- Don't invent metrics, activity, successful provider responses or unavailable cost.
- Don't restore the rejected tall configuration/simulation wall in the workspace.
- Don't treat this workspace composition as an approved comp or a universal layout rule.

## Review

Verify desktop (1440), laptop (1024), tablet (768), phone (390) and narrow phone (320) in both themes. Check overflow, contrast and accessible names with browser automation. Check native dialog focus and dismissal, persisted agent creation, outbound pause, login/session controls and real PostgreSQL records. Screenshots of both themes, sign-in and the create dialog are generated by the integration suite; no sample activity is fabricated in the application.

## Decisions and maintenance

This file is the single design reference for Orbit. Keep the lowercase filename `design.md`; do not create a competing `DESIGN.md` or move the guidance into a skill's private context file.

| Date       | Source                                                                                                         | Decision                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-16 | User: “dark and light mode, a mode switch, auto, responsive design. Use the logos.”                            | Support Light, Dark and Auto, responsive layouts, the supplied logo and a matching favicon.                                                                                   |
| 2026-11-16 | User rejected the first dashboard and chose “Vercel inspired”.                                                 | Use the Vercel-inspired direction documented above as the design brief. Generic marketing copy and a large promotional hero are rejected precedents for this admin interface. |
| 2026-11-16 | User: “Let's also use all of these. Install them” and “capture our decisions and style guidance in design.md”. | Use the installed design collections as complementary guidance; record decisions and relevant implementation guidance here after UI changes.                                  |

The exact typography, token values, table layout and modal behaviour above describe the current implementation. They are not separate user mandates. Preserve them for consistency during refinement; distinguish a proposed change from a preference the user has explicitly chosen. Record user-stated reasons when available; do not invent reasons or turn a local preference into a universal ban.

After implementing a UI change, update the relevant section here with the final behaviour, affected shared tokens/components, rationale or source decision, and actual verification. Replace superseded guidance rather than appending contradictory rules. Capture limitations honestly. Automated accessibility scans complement keyboard and rendered review; they do not establish complete WCAG conformance.

## Design skills and review workflow

The following collections are installed in the current Codex environment. Installation does not imply every skill has been invoked or that the current UI passed each collection's review. Project instructions and the user's selected direction take precedence over a skill's defaults.

| Collection                                              | Installed scope                                                                                                                       | Source revision                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill)  | `design-taste-frontend` 2.5.1                                                                                                         | `f6b76575f949707b4e3c37cd86cb44b0b98643e8` |
| [Jakub Krehel](https://github.com/jakubkrehel/skills)   | All 14 skills, including the seven `better-*` skills, `interface-review` and focused exploration tools                                | `6c2120103600407a1a9986afd834e73144ef8998` |
| [Emil Kowalski](https://github.com/emilkowalski/skills) | All 20 skills for design engineering, motion, mobile, stress testing and related workflows; `prototype` installed as `emil-prototype` | `64eb3deb9a5fbfa041faf783e0bc3fd635872e9c` |
| [Impeccable](https://github.com/pbakaus/impeccable)     | The unified `impeccable` skill, references and engine launcher; skill metadata 4.9.2                                                  | `d41d9860b0094dcb68030657da63461212835aaa` |

Use these together according to the task, rather than running every workflow on every edit:

1. Read this file, the architecture and the existing implementation first. Treat the console as Impeccable's **Operate** mode: task completion, familiar controls, scanability and consistent states are the priorities. Brand remains in precise details and the original logo.
2. Use Jakub's `better-interface` for a requested holistic screen/flow review. Its owning domains run in order: accessibility, layout, writing, typography, colors, UI. Findings need source and rendered evidence, user-impact ranking and explicit coverage. `interface-review` is available for an explicitly requested change review. Respect tools marked user-invoked.
3. Use focused `better-*` skills for the domain being changed. Retain the project's shared components and semantic tokens. Report actual failures rather than treating a different aesthetic preference as a defect.
4. Use `emil-design-eng` and relevant focused skills for interactions. Decide whether motion earns its cost before adding it; frequent actions should remain immediate. Use reduced-motion support, intentional easing and short transitions. Use `mobile-native` and `break-ui` for touch behaviour and worst-case content. `emil-prototype` is available for requested variant exploration without occupying another author's `prototype` name. Sonner and native-platform skills apply when those technologies actually enter scope; installation alone is not a reason to add them.
5. Use Impeccable's relevant critique, audit, harden or polish playbook for the requested task. Keep its product context consistent with `architecture.md` and its visual guidance consistent with this file. Marketing-site presets, decorative motion and arbitrary font/palette replacements must not override the selected console direction.
6. Verify changed behaviour in the real application, including both themes, keyboard/focus, narrow layouts, empty/error/pending states and relevant persistence. Preserve the existing PostgreSQL integration tests. Record commands and results; never label a skipped review or unavailable check as passed.
7. Update this file after implementation. Emil's `learn-taste` provides a useful framework for tracing corrections to the user's words; the user's explicit instruction here authorizes documenting established decisions directly, without a repeated approval step. Ask only when a genuinely new preference is unresolved.

Global installation locations are environment-specific and are not application dependencies. The collections are linked into the standard agent skill directory and the existing Codex skill directory. Upstream sources remain intact; only the local copy of Emil's prototype skill changes its frontmatter name to `emil-prototype`. No existing `prototype` skill is replaced. Review updates deliberately rather than silently refreshing these revisions.

## Review and verification — 16 November 2026

Scope: administrator sign-in, overview, agent creation, full mission disclosure, appearance selection, global pause and recent activity. This is a refinement of the selected Vercel-inspired Operate interface. The review used Jakub's six owning domains and interface orchestration, Emil's design-engineering, mobile-native, stress-testing and motion-review guidance, and Impeccable's audit/polish/Operate guidance. Taste Skill's plain-copy and alignment principles remain applicable. Native Swift/Expo, gestures, Sonner and alternative-prototype workflows do not apply to this web console; no unrelated capabilities were added to invoke them.

| Priority | Location                                              | Before                                                                                   | After                                                                                             | Why                                                                                                                                                      |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | `apps/web/src/app/page.tsx`, mission disclosure       | Mission ellipsis and a pointer-only title                                                | Full mission text beneath the agent name (supersedes the initial disclosure)                      | Full values must be available without hover.                                                                                                             |
| High     | `apps/web/src/app/create-agent.tsx`, form action      | Generic errors; validation focused a disabled input                                      | Field-specific errors, aria-invalid/describedby, read-only pending fields and first-invalid focus | Validation must explain recovery and keep the user's work.                                                                                               |
| Medium   | `apps/web/src/app/globals.css`, input/control tokens  | Pale input boundaries                                                                    | Dedicated control-border tokens                                                                   | Measured boundary contrast: 3.545:1 for #888 on white; 4.421:1 for #777 on the dark surface.                                                             |
| Medium   | `apps/web/src/app/globals.css`, type and reflow       | 10–11px metadata, fixed-pixel type, undersized mobile inputs                             | Minimum 0.75rem metadata, rem type, 1rem touch inputs, wrapping layout                            | Improve readability, avoid iOS focus zoom and preserve content when text is enlarged.                                                                    |
| Medium   | `apps/web/src/app/theme.tsx`                          | Native dropdown; effect-synchronized local state                                         | Sun/moon/monitor radio segments with useSyncExternalStore                                         | The user requested a nicer toggle. Native radios retain one tab stop, arrow keys, checked-state announcements and persisted Light/Dark/Auto preferences. |
| Medium   | `apps/web/public/theme.js`, theme bootstrap           | Colours interpolated during a theme swap; browser chrome did not track the selected mode | Instant theme colours; OS and cross-tab changes update the resolved browser appearance            | Theme changes must not create low-contrast intermediate frames.                                                                                          |
| Medium   | `apps/web/src/components/ui/submit-button.tsx`        | No pending feedback on sign-in, sign-out or outbound controls                            | Shared pending labels and disabled submit controls                                                | Make in-flight actions apparent and prevent repeated submissions.                                                                                        |
| Low      | `apps/web/src/app/globals.css`, pointer/overlay rules | Ungated hover and chained overlay scrolling                                              | Capability-gated hover, reduced-motion-aware press feedback and contained overlay scrolling       | Preserve native touch and keyboard expectations.                                                                                                         |
| Low      | `apps/web/src/app/page.tsx`, control semantics        | Red styling on a reversible pause                                                        | Neutral outlined pause control                                                                    | Reserve destructive styling for destructive effects.                                                                                                     |
| Low      | `apps/web/src/app/globals.css`, table headings        | User-agent centring of headers                                                           | Explicit logical start alignment                                                                  | Headings should align with their data in both directions.                                                                                                |

Coverage: accessibility, layout, writing, typography, colours and UI polish were inspected in the sign-in/create-agent/overview path. Verification includes rendered Chromium checks, native radio keyboard interaction, focus entry/return, required fields, real PostgreSQL mutations, validation, failed network requests, preservation of entries and pending state. Both themes passed axe checks at 1440, 1024, 768, 390 and 320 pixels. Worst-case accepted names and long missions, 200% text enlargement, RTL layout, system-theme changes and reduced motion were exercised. The native radio selection has a distinct control-border outline. Touch targets are larger on coarse pointers; physical iOS/Android hardware and screen-reader speech output remain unverified.

The feature branch contains `origin/main` through `35eeb75`. Main's format, lint, unused-code and React Doctor gates remain intact. TypeScript follows main’s supported 6.0.2 because typescript-eslint 8.72.2 rejects the TypeScript 7 compiler API. Migration tooling lives in `scripts/migrate.ts`, outside the web application's source tree, and preserves sequential transactional migrations. Knip explicitly registers the served `public/theme.js` entry, which is loaded by URL and cannot be inferred as an import. The browser integration suite uses the disposable `orbit_test` database; it does not truncate development data. A CI integration job now applies its migrations and runs the same production-build browser tests.

Verification results:

- Production build, formatting, web/worker type checks, strict ESLint and Knip: passed.
- Five browser/PostgreSQL tests: passed, including the appearance control's arrow keys and persisted selection.
- Impeccable manual source detector: no findings (`[]`). This is not a claim that every runtime rule or every skill passed a separate audit.
- React Doctor local full analysis: `ok: true`, zero errors, zero warnings, zero diagnostics.
- The unchanged `bun run validate` gate cannot complete in this environment: the required React Doctor score API at `https://www.react.doctor/api/score` is refused by the network proxy with HTTP 403. No 100/100 remote score has been verified, and no score or rule was bypassed to turn this green.

Screenshots in `test-results/` show real database-backed test operations, not runtime-provider activity. At that review milestone, the full agent runtime and provider connections were unavailable. The later workspace milestone below adds manual provider inference; schedules, channel integrations and live actions remain outside scope. Keep current limits visible in the console.

### Login refinement — 16 November 2026

The user requested the same level of polish on sign-in as on the dashboard. The login panel now uses the original Orbit emblem instead of a generic lock tile, a clearer heading/body hierarchy, consistent 44px form controls, and a show/hide-password action using the existing icon and button system. The administrator note no longer needs a second divider. The shared appearance switch stays in the header and the layout remains centred and scrollable on short screens.

Verified the login surface in both themes at 1440, 1024, 768, 390 and 320 pixels, including axe scans, password visibility by keyboard, preserved password value when switching visibility, invalid credentials, 200% text enlargement and a 390×500 short viewport. Fresh desktop/mobile light/dark captures and the mobile error state live in `test-results/login-*.png`. The production build and all five browser/PostgreSQL tests passed. Formatting, strict lint, type checks and unused-code checks passed; Impeccable's source detector returned no findings. Physical-device keyboard behaviour remains outside the available test environment.

### Local development authentication — 16 November 2026

The user requested `AUTH_DISABLED` now and explicitly deferred OAuth and magic links. In validated local development mode, `/login` redirects to the dashboard and a persistent neutral, bordered notice reads “Authentication disabled · Local development” followed by the explicit local identity. That identity also appears in the existing footer and database audit history. The notice wraps on narrow screens and follows the shared colour and border tokens. Hide Sign out in this mode because there is no session; retain the existing password-login design when authentication is enabled. This mode requires the guarded loopback launcher, local app/database URLs and NODE_ENV=development, and is rejected during production startup.

Authentication-bypass verification: 12 configuration/startup tests passed, including an actual production server that exits with code 1 and leaves its health endpoint unreachable. The five password-login browser tests passed. A separate cookie-free local development test passed against PostgreSQL: it exercised agent creation and pause controls, verified the configured audit identity, confirmed zero session/login-attempt records and no session cookie, and rejected a mismatched request Host. The development launcher itself runs with Bun and launches Next with its standard Node runtime, avoiding Bun-specific flags leaking into Turbopack's Node subprocesses. OAuth and magic links remain deferred as explicitly requested.

### PR review — 16 November 2026

Synced the feature branch to main's validation-tool update (`35eeb75`) and retained its pinned tooling. The global pause form now submits an explicit desired state instead of toggling the database value: repeating the same request must not accidentally resume outbound activity. The PostgreSQL browser suite replays the exact authenticated mutation to verify this property. Generated Next type references use production build paths; Next's generated workspace instructions are retained. Local design skills remain installed in the agent environment, with their provenance and working conventions recorded here; their upstream repositories are not vendored into the application.

### Reviewer typography decision — 16 November 2026

The user requested a different font pair in PR #11. IBM Plex Sans Variable replaces Geist throughout the console and login; IBM Plex Mono is limited to activity timestamps and small counts. The mono face is explicitly weight 400, matching its bundled face. Shared layout, type sizes, themes and the original Orbit logo remain the design foundation. Typography review uses the installed `better-typography` guidance, including loaded weights, wrapping, 320px reflow and 200% text enlargement.

Verification after the reviewer changes: production build, 14 environment/startup tests and all six PostgreSQL/browser tests passed. Both themes passed axe and overflow checks at 1440, 1024, 768, 390 and 320px, including long content, 200% text and RTL. Browser assertions confirmed the self-hosted sans face loads; fresh dashboard and sign-in screenshots were inspected at desktop and mobile sizes. No actionable typography findings in this scope. React Doctor's local full analysis still reports zero diagnostics; its mandatory remote score request remains blocked by the environment proxy (403), so 100/100 is unverified.

Both Docker images were built and run. Testing found unreadable copied files under the non-root runtime user; runtime copies now explicitly belong to `bun`. The web container passed health, icon, static/font loading, sign-in, agent creation and real PostgreSQL audit persistence checks; production bypass startup exited with code 1. The worker logged startup and exited cleanly on shutdown. CI now builds both images on PRs and smoke-checks web assets and worker shutdown. This environment supplies its trusted proxy CA through an optional build secret; TLS verification stays enabled and the CA is not copied into the runtime image.

### Mission text — 16 November 2026

The user rejected the repeated “View mission” controls. Missions now appear as ordinary text directly below agent names, using the shared muted colour and 13px body style with 1.6 line-height. The full mission wraps without clipping or disclosure controls, including on narrow screens. This replaces the earlier details/summary pattern.

Verified with a production build and all six PostgreSQL/browser tests, including both themes at five viewport widths, a 2,000-character mission, 320px reflow, 200% text and RTL. Fresh desktop/mobile captures were visually inspected. Formatting, types, lint and Knip passed. The unchanged React Doctor remote score request remains blocked by the environment proxy (403).

### Templates and agent workspace — 16 November 2026

The user rejected the tall workspace form/panel layout and requested Impeccable with
“Both: rethink the layout and visual treatment,” retaining the Orbit logo, IBM Plex
fonts and both themes. The task tabs and section editor described in Components
supersede the previous side-by-side configuration/simulation and mobile anchor links.
No concept-seed round, approved decision comp or QUALITY BAR was produced. This is a
code-led composition within the confirmed Vercel-inspired brand; it is not evidence
of fidelity to an approved comp or completion of every Impeccable workflow.

The create dialog's native template selector fills the mission; creation copies the
stored defaults. Template changes never alter existing agents. Name remains the
initial dialog focus, with the selector preceding it in tab order. Every configuration
save creates an immutable snapshot; conflict errors retain unsaved values. The
simulation version resets to the newest save but preserves historical selection
across replay submissions. DeepSeek V4.1 Flash 1017 is the current default; migration
0002 preserves existing snapshots and customized model IDs.

Earlier milestone verification (before this redesign):

Verification: production build and the seven browser/PostgreSQL tests passed,
including the new template-copy, independent configuration, encryption/removal,
persisted failure and reload flow. Both themes passed axe and overflow checks at
1440, 1024, 768, 390 and 320px; desktop light and mobile dark screenshots were
visually inspected. Existing keyboard dialog, local-auth, text enlargement and RTL
checks remain intact. Runtime tests cover multiple/no actions, suppressed effects,
partial failure, provider credential boundaries and encrypted-secret isolation.
Persistence tests invoke the shared runtime in separate Bun processes, stop those
processes, then inspect distinct John/Sarah results from fresh PostgreSQL connections.
Inference is mocked in these tests; real OpenRouter response quality remains untested
without an administrator-supplied key. React Doctor returned 100/100 with no local
diagnostics. No architecture document changes or live integrations are included.

Worker packaging verification: the Docker image builds with the environment’s trusted proxy CA and imports the shared persistence runtime as the non-root user. Package manifests now belong to that user, resolving Bun’s read-permission warning.

Redesign verification: final validation passed, including React Doctor 100/100.
Production build, seven browser/PostgreSQL tests, 20 unit
tests and three persistence tests passed. Both themes passed axe and overflow checks
at 320, 390, 768, 1024 and 1440px. Keyboard task tabs, retained unsaved configuration
across tab changes, configuration snapshots and provider-key save/removal were
exercised. Desktop 1440px and mobile 390px captures of the workspace views, template
editor and empty Playground in both themes are in `.impeccable/review/` and
`test-results/`. The finish review found no material rendered defect. Its documentation finding is
resolved by this update. The surface contract now discloses that no concept-seed
round occurred; the reviewer retained that procedural gap as a partial finding.
This is not a claim that the complete Impeccable workflow passed.
The source detector returned `[]`. No real provider call was made: no administrator
key was available. Mocked inference does not establish real provider response quality.
Automated checks do not establish complete WCAG conformance, physical-device behavior
or screen-reader speech output.

### Agent profile pictures — 16 November 2026

The user requested editable agent pictures and selected RustFS for durable storage.
Identity now begins with a compact preview and Upload/Change picture and Remove
picture controls. Pictures save immediately and independently of configuration
versions; upload events do not clear or mark configuration fields as changed.
The workspace header and agent list share the image component, retaining an initial
when no picture is set or storage cannot serve it. Uploaded pictures remain visible
in the agent list on narrow screens; the previous small-screen initials rule remains.
The 64px desktop / 48px mobile preview uses existing border, radius and theme tokens.
Accept JPEG, PNG and WebP up to 5 MB, normalize to a 512px square WebP, and strip
metadata. Pending, failure and storage-setup messages are inline. Private RustFS
objects are served through authenticated Orbit routes.

Desktop light and mobile dark screenshots were visually inspected. Automated tests
cover both themes at 1440, 390 and 320px, including overflow and axe checks. The
RustFS integration exercises authentication, private objects, independent agents,
unsaved-edit preservation, failed storage writes, stop/start persistence, replacement
and removal. Screenshot fixtures use a generated silhouette, not a real person.

Final picture milestone verification: production build, all eight browser tests,
22 unit tests, strict validation and React Doctor 100/100 passed. The web Docker
image builds, and its packaged native WebP processor and S3 client were exercised
as the non-root runtime user. Captures are saved in
`.impeccable/review/profile-picture-Light-1440.png` and
`.impeccable/review/profile-picture-Dark-390.png`. No remote infrastructure was
provisioned and no real OpenRouter call was made during this milestone.

### Agent knowledge library — 18 November 2026

The Knowledge tab is list-first: documents with explicit pending/processing/ready/failed
Badges, then a retrieval inspector. Empty library uses a dashed dropzone; header Upload
remains available once documents exist. Row meta is muted sans (not mono debug dumps);
actions use an ellipsis menu with delete confirmation. Inspector query is a single-line
InputGroup; hit counts and stub-embedding notices live in the inspector results header.
Wide layouts place the inspector beside the list; below 900px they stack. Soft refresh
also covers in-flight knowledge jobs. Mobile workspace tabs use the compact Select
pattern shared with the UI redesign.
