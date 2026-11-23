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

## Design direction

Orbit is a private administration console for independent AI agents. The
Vercel-inspired visual direction uses neutral surfaces, crisp one-pixel borders,
restrained density and clear type. Lead with operational content, visible state
and the next available action. Keep the original orbital emblem and its
violet/cyan colour in the header, sign-in and favicon.

This is the single design reference for Orbit. [Architecture](architecture.md)
owns product and runtime constraints. Update the relevant section here when
behavior or design decisions change.

## Visual system

Use the semantic tokens in the frontmatter for both light and dark appearances.
Primary actions reverse the neutral foreground/background pair. Violet marks
the active agent task, selected sections and the editor caret. Blue marks
keyboard focus. Red marks errors and destructive actions. The reversible global
pause uses a neutral outlined button. Use text alongside status colours.

Self-host IBM Plex Sans Variable for the interface. Use IBM Plex Mono at weight
400 for activity timestamps and small counts. Page headings use the headline
role and editor and result headings use the title role. Ordinary section
headings use 0.875rem at weight 600. Row titles and labels use 0.8125rem at
weight 500. Metadata starts at 0.75rem. Page headings reduce to 1.375rem on
phones, and text inputs use at least 1rem on narrow or coarse-pointer screens.
Use rem units for type and keep editor explanations within 68ch.

Controls use 6px corners, panels 8px, state labels 5px, dialog and sign-in
shells 10px, and agent monograms 12px. Use borders and tonal separation for
depth. Reserve shadows for inputs, selected appearance segments and
overlays. The shared dialog uses a 50% black backdrop.

## Console layout and navigation

Use a 1280px container for the sticky header and main content, with 40px
desktop gutters, 24px tablet gutters and 16px phone gutters. Main content
starts 32px below the header on larger screens and 24px below it at 600px
and narrower. Use a 4px spacing rhythm and align page headings and actions
to the same grid.

The desktop header keeps the brand, appearance and account controls above
a 44px navigation row. At 600px and narrower, the Workspace navigation menu
holds the same destinations and marks the active page. The global destinations
are Overview, Approvals, People, Evaluations, Templates, Knowledge, Skills and
MCP. The Approvals link shows the workspace-wide pending count when there are
pending items. Agents, recent activity and outbound controls are sections of
Overview. The agent breadcrumb
links directly to the Agents section.

Keep the header below menus and dialogs, respect the top safe area and leave
clearance for focused controls and anchor destinations. Every console page
starts with a keyboard-visible skip link to its main content.

### Overview

Show database-derived counts, the agent table, recent audit activity and global
outbound controls. Explain that external writes stay suppressed except for
registered Live adapters after administrator approval (email replies today).
Put the full mission beneath each agent name in muted,
wrapping text. Preserve line breaks and let long words wrap. Align table
headers to the logical start. Activity stacks below the primary column on
tablets. Controls stack and agent names wrap on phones.

The global pause action submits the desired state so repeating a request has
the same effect. Show its current state in text and give the action a pending
label while it saves.

After authentication, Overview keeps its heading and navigation visible while
the agent summary, table and activity load. Placeholders use the same responsive
grid and table columns as the loaded view. Keep them static and out of the
accessibility tree. A visible loading status announces the wait. Routes with
variable content use a compact Orbit loading indicator. Spinner motion follows
the reduced-motion preference.

### Sign-in and appearance

Use a centred, scrollable 400px panel with the 64px emblem, a 24px heading and
44px form controls. Provide a keyboard-accessible password visibility button
that preserves the password value. Sign-in and sign-out show pending feedback
and guard against repeated submissions.

Light, Dark and Auto use native radio segments with sun, moon and monitor icons.
The group takes one tab stop and supports arrow-key navigation. The selected
segment has a visible border and fill. Save the preference locally, apply it
before paint and change colours immediately. Auto tracks the operating system,
and browser theme colour follows the resolved appearance.

Validated local development with authentication disabled shows a persistent,
wrapping notice with the configured local identity and omits the Sign out control.
The identity is also used in the audit trail. See [local development](docs/development.md)
for the guarded launcher and environment options.

## Shared controls

Use the shared primary, outline, ghost and destructive buttons. The standard
height is 36px, workspace save controls are at least 40px and key touch actions
are at least 44px. Gate pointer hover effects by input capability. Pointer press
feedback uses a short scale transition with a strong ease-out. Keyboard actions
and reduced-motion interaction remain immediate. Use a visible two-pixel
focus outline with clearance from the control.

Use the shared shadcn Field, Label, Description, Error, Input and Textarea
primitives with the dedicated control-border token. Align related inputs at
40px on desktop, and place help below the control so wrapping help does not
stagger paired inputs. Link help and validation with `aria-describedby`
and use `aria-invalid` for invalid fields. Preserve entries on recoverable
errors and reveal the containing section before focusing an invalid field.
Use a shared form dialog with a compact header, scrollable body and a visible
action footer. Match the width to the task. Use a narrow dialog for agent
creation, a medium dialog for connections and a wide dialog for skills.
Separate save bars with a top border and subtle fill.

Use the Markdown editor for skill bodies and configuration prompt fields.
Write uses the editable Markdown source. Preview renders it and Split shows
both panes side by side, stacking them on phones. Toolbar actions format the
selection and participate in native undo. Keep the source value in the form
when changing modes. Email and approval drafts use the shared plain text
textarea.

Use the shared Select for choice lists and compact section navigation.
Menus align to the trigger and match its width. Flip or scroll the menu
when space is tight, allow long option labels to wrap and place the menu
above its dialog. Escape closes the menu first and restores focus to its
trigger. Use disclosures for optional settings and native details for
expandable records.

### Create agent

Use the shared Dialog with initial focus on Name and the template selector
immediately before it in the tab order. Choosing a template fills the mission.
Creation copies the selected defaults and starts the agent in Shadow with
external writes suppressed.

Trap focus in the dialog and return it to the trigger on dismissal. Escape,
Cancel and Close dismiss the dialog when idle. Backdrop clicks preserve the
draft. While submitting, keep text fields read-only and disable dismissal
and duplicate submissions. On validation failure, retain entries and focus
the first invalid field. On success, close after the server action completes.

## Agent workspace

Show agent identity, lifecycle, current configuration version and OpenRouter
status above the task tabs. The tasks are Configuration, Playground,
Knowledge, Memory, Email, Follow-ups, History, Approvals and Access. Save evaluation
cases from History or Email; open Comparisons from the global Evaluations
page. Use a horizontal tablist with Left, Right, Home and End support above
600px and a full-width Select at 600px and narrower. Keep task panels mounted
so drafts survive navigation.

### Configuration and identity

Use one editor and one save bar. Identity, Behaviour, Discovery and Models
each expose one field group. Discovery holds the admin-only X search query
(one per agent); blank disables polling. The section navigator is 192px wide
and reduces to 156px at 900px and narrower. At 600px and narrower it becomes
a horizontal row and identity fields stack.

Each configuration save creates an immutable version. Keep unsaved values
on conflicts. After saving, Playground defaults to the newest version.
A deliberately selected historical version can be reused for replay.

Identity starts with a 64px picture preview, reduced to 48px on phones,
and Upload or Change and Remove controls. The agent heading and table
share the avatar and fall back to an initial when a picture is unavailable.
Keep uploaded pictures visible on narrow screens. Picture changes save
independently of configuration and preserve unsaved editor fields.
Accept JPEG, PNG and WebP up to 5 MB and normalize to a metadata-free
512px square WebP. Surface pending, failure and storage setup inline.
Serve private pictures from authenticated Orbit routes.

### Playground and history

Use a single conversation column. Align the configuration version and
optional recipient disclosure by label and control height on wider
screens, and stack them on phones. Keep the empty state compact so the
text composer is easy to reach. Explain that model usage can incur charges
and that the simulation does not post or send anything. Use the same
recipient IDs as the consent records.

The History tab is the agent activity timeline: playground simulations and
X discovery evaluations. Label each entry by origin. Discovery rows show
evaluator reasoning and proposed actions; shadow mode keeps proposals
recorded and never sent.

Show queued, running, awaiting approval, completed, failed and interrupted
states from persisted records. Stop watching explains that inference can
continue and links to the matching History entry. An awaiting-approval run
links to its review. Refresh while runs, knowledge jobs or scheduled
follow-ups are in flight so saved results appear without a manual reload.

History leads with the per-agent activity timeline (follow-up outcomes and
related internal events), then run details, exact configuration snapshots,
linked job status and the provider's recorded cost. Label missing cost
explicitly. Use a flexible primary column and a 280px version column,
stacked at 900px and narrower. Preserve source citations with saved runs.

### Follow-ups

Administrators schedule durable follow-ups for an agent from the Follow-ups
tab: subject, optional note and due time. Rows use the same disclosure
pattern as History. Expand a row to inspect source, actor, attempts, job
status, cancellation and the recorded outcome. Cancel is available only
while status is scheduled. Due execution writes an internal activity
outcome only — no external side effects. Paused and stopped agents
skip-and-record due follow-ups (see [docs/follow-ups.md](docs/follow-ups.md)).

### Knowledge

Use Documents, Inspector and Playground sections in a left navigator that
switches to a Select at 900px and narrower. Keep section drafts mounted.
Make Documents list-first. Show a dashed dropzone when empty and keep
Upload in the header once documents exist. Document rows show title,
status, file type, size, chunk count and relative update time with full UTC
available. Use an ellipsis menu for row actions, confirm deletion and show
failures inline with Retry.

Keep private document controls in Documents and list the agent’s granted shared
libraries below them. Show each library’s ready document count and link to its
workspace page. Indicate when the agent’s knowledge search is disabled.

Use an inline query and Inspect action for the Inspector. Show retrieval
errors in the Inspector panel. Results list rank, combined and component
scores, with detailed match reasons in a disclosure. Label stub embeddings.
The Inspector previews the private documents and shared libraries available to
the selected agent. It remains usable when the agent’s Playground search is off.
Playground retrieval uses a Switch. Grounded answers use numbered citations
with filename, page or section and the quoted passage. Inspector and citation
source links download the original through the selected agent’s current access.

### Memory

Use the workspace disclosure rows to list learned company, project and person facts.
Keep the fact, learned timestamp and active, review due or expired state visible
in the collapsed row. In the expanded row, use **View original source** across
channels and let admins correct the fact and UTC dates or confirm removal. A corrected
entry labels the original quote as the evidence for what was first learned.
Use a single date column on phones and keep source text readable as plain text.
Show memory evidence links alongside the corresponding answer in Playground,
History and replay comparisons. Keep Knowledge citations alongside their
quoted passages.

For person facts, label the controlled field (Company or Job title), use a
single-line correction input, and link to the current person in the owning
agent’s view. Keep the original evidence link on the same row.

Use a **Retention** disclosure above the entries. Provide independent day limits
for facts, notes and outcomes, plus a daily or weekly maintenance schedule. Keep
review due and expired labels on individual entries. Show the original evidence
for a note or a recorded send using the same evidence view.

Playwright verified evidence access at 1440px and correction, expiry and removal
at 390px in Dark mode, including keyboard focus and mobile overflow checks.
The mobile flow also saved separate fact and note retention periods with a weekly
maintenance schedule.

### Email

The Email task tab uses the existing responsive workspace navigation. The mailbox
card shows the assigned address and the enable or disable action. The thread list
highlights the selected conversation. Messages show the processing state beside the
subject and sender. Pending reply drafts use an editable textarea with Approve &
queue and Reject. Knowledge citations stay beneath the draft. After review, the
thread shows the send outcome (queued, sending, sent, failed, blocked) and reason.
Message content and replies render as plain text. Destination and threading headers
are never editable. Email work participates in the workspace’s pending-state refresh.

Playwright verified admin mailbox controls, thread navigation, draft review,
send-outcome rendering, and the mobile layout in both themes at 1440px and 390px.

### Access

Use a left navigator for Lifecycle, Budgets, Approvals, Consent, Skills,
MCP and OpenRouter. At 900px and narrower, switch to a Select. Keep panels
mounted to preserve unsaved fields.

- **Lifecycle** uses radio cards and explicitly describes the current limits of Live mode.
- **Budgets** group related values in a two-column desktop grid. Align each No cap Switch with its spend label on wide screens and put it below the label on phones. Keep units next to the input.
- **Approvals** uses Switch rows with an action label and description, plus the optional spend threshold, expiry and rejection behavior. Saving these settings creates a configuration version.
- **Consent** shows saved recipient, scope, choice and evidence records above the form. Let administrators decide whether introductions and escalations require recorded consent.
- **Skills and MCP** use checkboxes to assign library entries. Attached MCP connections show a nested checklist of administrator-classified read-only tools. New attachments start with an empty checklist.
- **OpenRouter** identifies the active source as an agent override, environment default or missing key. Use a password input for the override and clear it after submission. Removing the override falls back to the environment default if configured. Display only the source label.

## People

Use a searchable list of people and a detail page with the activity timeline
first. Show contact methods, linked identities and their source evidence next
to the timeline on larger screens and below it on smaller screens. Link the
email sender and X author from their existing agent workspaces using underlined
links. Keep a return link to each original thread or X activity.

Label inferred and confirmed links in text. Linking and unlinking both show
the evidence being acted on and require a reason. The relationship timeline
shows the observing agents. Choosing one agent narrows the timeline and
reveals only that agent’s private notes and their supporting excerpts. Manage
identities and contacts from the all-agents view.

Show active private memory facts with source links below the timeline when an
agent is selected. Place each fact on the current person of its source identity.

Playwright exercised the link and unlink flow at desktop and phone widths,
opened the supporting email from a private note, and checked keyboard access,
overflow, and automated accessibility in both themes at 390px.
Chromium also verified the structured Company correction, the return from
Memory to the agent’s People view, and the fact’s placement after unlinking.

### Introductions

Open Introductions from People. Use the same list and detail layout. Each
proposal shows its originating agent and run, the reason for the match, and
two independently labelled consent cards. Stack the cards on narrow screens.
Show each person’s display name and blurb beside the name of the person who
would receive them. Record an explicit decision and evidence reference for
each person. Keep a revocation action available after agreement.

The second agreement creates a read-only draft in Approvals with a link back
to the disclosure and consent. If a person revokes an agreement after
approval, show Blocked on the proposal and preserve the approval decision in
history. Configure People tool grants in Access → Consent.

Playwright recorded the first agreement at 1440px, then exercised drafting,
approval, and revocation at 390px. It checked for horizontal overflow and ran
automated accessibility checks on the draft view at 390px.
A live-mode run used OpenRouter to generate Maya’s proposal for synthetic
participants. The browser recorded both decisions, approval, and revocation.
Both saved-case replays completed with live inference and left the proposal
and delivery records untouched.

## Workspace libraries and approvals

Templates are flat disclosure rows with title, role and revision. Expanded rows
use the shared section editor and save bar. Saved defaults apply to future
agent creation.

Skills and MCP have list-first pages with one New action in the heading, a
bordered table for saved entries and a concise empty state. Create and edit
open the shared form dialog. Give the skill body the largest editing surface
and keep the title, slug and usage guidance above it. The slug follows the
title until edited. The MCP connection form uses a
transport Select, chip rows for the tool allowlist, an optional Fetch tools
action and key/value rows for auth headers. Display stored auth as a masked
state. New tools default to Mutating. Changing an endpoint requires the
stored headers to be replaced or cleared before discovery or save.

Workspace Knowledge lists named libraries with document and access counts.
New library opens the shared form dialog. A library page uses the same document
controls and shows each agent’s grant with an explicit Grant access or Revoke
access button. Library membership takes effect on the agent’s next retrieval
request and source downloads check it each time.

Playwright verified library creation, keyboard focus return, and grants at
1440px, then revocation and document maintenance at 390px. It verified source
downloads at both widths and covered the private document flow.

The workspace Approvals inbox shows pending proposals newest first and groups
resolved entries under History. Show agent, action, recipients, originating
run link when available, draft and age. Use one initial timestamp for relative
ages on the server and browser and show the full UTC timestamp on demand.
Support filtering by agent or run, and cap bulk selection at 50.

### Evaluations

Global Evaluations navigation lists saved cases and comparisons. Cases come
from completed History runs or inbound email via an inline “Save as case” form.
Use the source channel label in the case list and comparison heading. Starting a
comparison requires one case and two distinct configuration versions for the same
agent. The comparison detail page shows
the shared input once, then a two-column side-by-side of drafts, citations,
policy decisions and run status. Stack the columns below 900px. Pending
comparisons soft-refresh like other in-flight workspace work. Replay runs use
origin `replay`; the policy gateway and outbound dispatch gate always suppress
external writes for that execution context.

### Channel activity

Use the registered channel name in History, Evaluations and People. In History,
link to a separate source surface when the channel provides one. In People, show
whether an interaction was received or sent and link each agent’s observation to
its originating run or provider surface. In Access → Approvals, show channel
permission controls when a registered action supports individual agent grants.
Actions that always require review use the same Approvals inbox as other proposals.

Chromium verified saving an X run as an evaluation case, tracing email and X
sources in People, and inspecting evaluation and email approval states at
1440px and 390px. The People and email views passed their mobile accessibility
and overflow checks in Light and Dark mode.

## Design review and verification

Review the console as an operational tool. Use the task-appropriate
Impeccable, Emil Design Engineering, Better Interface or focused design
workflow. Prefer familiar controls, clear labels, short task paths and
behavior that the running application can demonstrate. Check formatting,
undo, preview, saving from Preview and focus return with the Skills browser
regression when changing the editor.

Use seeded local data for screenshots and a disposable test database for
browser integration. Check Light and Dark at desktop, tablet and phone
widths, including 1440, 1024, 768, 390 and 320px where relevant. Exercise
keyboard focus, Escape and focus return, pointer interaction, short
viewports, long content, 200% text enlargement, RTL and reduced motion
where the change could affect them.

Check contrast, accessible names and horizontal overflow with browser
automation. Exercise relevant empty, loading, pending, error and success
states. Validate saved behavior for agent creation, configuration versions,
libraries, run recovery and outbound controls when those flows change.
Use [the testing policy](docs/testing/README.md) for suite selection.
Record revision-specific results in the change review. Automated scans
complement rendered and keyboard review. Physical-device behavior,
screen-reader speech and real provider quality each need their own evidence.
