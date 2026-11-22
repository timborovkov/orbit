# Orbit

Product vision and architecture outline  |  15 November 2026  |  Planning document v4.1

A self-hosted control centre for autonomous, persistent AI representatives. This document consolidates the agreed product direction, operating model, integrations, constraints and implementation priorities. It is intentionally a product and architecture brief, not a prescriptive code-level specification.

## 1. Executive summary

Orbit lets an administrator create and operate multiple independent AI agents. Each agent has an identity, personality, mission, natural-language instructions, model configuration, credentials, tools, schedules, knowledge, memories, conversations, budgets and execution policies. Agents can proactively discover opportunities, respond to incoming events, form relationships and complete tasks over time.

Orbit is not a multi-tenant SaaS in its first incarnation, nor a single-purpose social agent. It is one privately deployed management platform. A sales agent (John), support agent (Sarah) and superconnector are configurations of the same runtime, not separate implementations.

## 2. Product principles
- Agentic by default: agents choose and chain authorised tools to pursue missions; no visual workflow designer.
- Configuration through plain text: personality, mission, engagement criteria and tool-use guidance; optional reusable agent templates.
- PostgreSQL first: external inputs, actions, decisions and task state are persisted durably before processing.
- Modular channels and tools: X is the social MVP; additional networks, email, MCP and real-world capabilities are adapters.
- Explicit guardrails: deterministic rules, platform permissions, consent, approvals, budgets and a global pause mechanism override model suggestions.
- Inspectable behaviour: shadow mode, playground, historical replay, evaluation datasets, Langfuse traces and action audit logs.
- Small deployment: one repository, Next.js web process, Bun worker, PostgreSQL and a few external APIs.

## 3. Technology and deployment
| Area | Chosen direction |
| --- | --- |
| UI | Next.js App Router, TypeScript, Bun, Tailwind, shadcn/ui |
| Data | PostgreSQL, pgvector, Drizzle ORM |
| Object storage | RustFS using its S3-compatible API; persistent volume and private buckets |
| Agents | Vercel AI SDK with OpenRouter; optional env default key, per-agent override |
| Workers | Separate Bun worker process sharing application modules |
| Scheduling | Durable PostgreSQL-backed jobs; LISTEN/NOTIFY only as a wake-up signal |
| Observability | Langfuse via OpenTelemetry for agent traces and evaluations; Sentry for application errors and performance; Orbit retains operational truth |
| Authentication | Environment-configured administrator password login; OAuth/magic links planned; no public registration |
| Hosting | Railway + Docker, single monorepo |
| Email | Resend for sending and inbound routing; PostgreSQL-backed virtual inboxes |
| Research | Exa web search; optional Firecrawl extraction and Browserbase later |

Deployment target: one web service, one worker service, PostgreSQL and RustFS on Railway. RustFS uses a persistent data volume; the web service accesses its private S3 endpoint. No Go, Redis, Kafka, Kubernetes or per-agent containers for the MVP. Separate credentials and data scopes provide logical isolation. Database migrations run automatically on Railway pre-deploy and again at web/worker process start under a shared Postgres advisory lock; operators do not apply SQL by hand for routine deploys.

## 4. Core agent model
| Element | Meaning |
| --- | --- |
| Agent | Long-lived identity with name, avatar, role, status and dedicated social/email presence |
| Template | Reusable starting configuration: sales, support, superconnector or custom |
| Personality | Natural-language voice, style, manner and interaction preferences |
| Mission | Outcome sought; goals and optional time-bounded campaigns |
| Instructions | Engagement preferences, escalation guidance and tool-use guidance |
| Model settings | OpenRouter key (env default or per-agent override), main model, cheaper evaluator model, parameters and budgets |
| Tools | Native API capabilities and individually allowlisted MCP operations |
| Triggers | Scheduled discovery, mentions, incoming email, webhooks and manual invocations |
| Knowledge | Agent-scoped documents and retrieved source passages |
| Memory | Structured person/conversation state and searchable facts |
| Execution mode | Fixture simulation, real-data shadow mode or permitted live mode |

Profile pictures are mutable agent identity, separate from versioned runtime configuration. Administrators can upload, replace or remove a picture; the web service validates and normalizes it, stores it in a private RustFS bucket, and saves only its object key in PostgreSQL. Authenticated routes serve pictures. Pictures are not included in model prompts or simulation snapshots.

An agent is a durable identity. Changing prompts, models, tools or policies creates a versioned configuration; relationships and conversation history survive revisions. Agents can be paused or archived. No internal agent-to-agent handoff framework is required: agents can introduce one another through ordinary authorised channels.

## 5. End-to-end event and action lifecycle
| Stage | Behaviour |
| --- | --- |
| Ingestion | Poll an approved API or receive a signed webhook; persist provider payload, source IDs and event metadata in PostgreSQL; deduplicate. |
| Queue | Enqueue durable processing work in the same transaction; notify workers after commit. |
| Deterministic screening | Blocklists, opt-outs, duplicate engagements, spam tagging, cooldowns, channel status and other code-enforced exclusions. |
| Cheap evaluation | Per-agent, plain-text relevance criteria evaluated by a small model; return zero or more candidate actions, not a single choice. |
| Main agent | Load versioned personality, mission, recent context, structured memory and relevant RAG passages; choose and chain tools. |
| Policy gateway | Check per-agent/tool permissions, provider restrictions, recipient consent, approvals, budgets, current mode and current blocklist state. |
| Execution | Persist action intent; dispatch allowed external writes; reconcile uncertain outcomes and avoid duplicate retries. |
| Follow-through | Store results and conversation state, schedule pending commitments and resume on future events. |
| Observability | Persist execution and action statuses in Orbit; emit diagnostic spans and scores to Langfuse and application errors to Sentry. |

All external inbound content is untrusted data, including posts, webpages, PDFs and MCP responses. It cannot grant permissions, change policy or access credentials.

## 6. Actions and social behaviour

An agent may propose several actions on the same post, such as reply + like + repost + follow, or choose no action. The evaluator suggests candidates; the main agent refines them; the action gateway independently authorises each one.
- X MVP: targeted discovery, mentions, thread context, replies and other actions only where the account’s access and platform rules permit.
- Future channels: Reddit (comments/upvotes), Bluesky, Instagram, LinkedIn, Telegram, WhatsApp Business and potentially WeChat, each with a capability-aware adapter.
- Following: prefer meaningful relationships; store who was followed, when, why and by which agent.
- Unfollowing: scheduled review of followed accounts using relevance, history, opt-outs, minimum durations and cooldowns; avoid follow/unfollow churn.
- No assumption that a provider API permits autonomous likes, follows, unsolicited replies or DMs. Platform access and policy compliance are prerequisites to live use.

## 7. Conversations, people and memory

Keep canonical people records, platform-specific identities, conversations, messages, contact preferences, relationship history and opt-out/consent evidence in relational tables. Never merge identities across platforms solely on similar names.

Allow agent-managed JSONB memory objects for flexible facts and notes, but not arbitrary table creation or unrestricted SQL. Store source evidence, timestamps, confidence where justified, visibility scope and expiry or review dates. Explicit consent is authoritative structured data, not agent-editable memory.

Use pgvector for semantic matching of knowledge passages, long-term textual memories, relevant public discussions and potential matchmaking candidates. Use relational queries for exact identities, permissions, statuses and recent threads. Combine vector similarity with PostgreSQL full-text search where useful.

An agent owns every fact, note and recorded outcome it learns. Store original source references and resolve person facts through the current identity of that evidence at read time. The first structured person fields are employer and job title. Person facts use exact identity matching. In channel runs, apply the same identity boundary to text learned from an identified sender before ranking, including company and project facts and JSONB notes. This prevents text from restoring a relationship that an identity unlink removed. Administrator-run Playground and evaluation comparisons can inspect agent-wide text memory without opening structured person facts. Verify ownership before any SQL ranking or evidence lookup.

The worker supplies bounded, untrusted memory context and offers policy-gated follow-up searches for memory, conversation history and Knowledge. Company and project facts and textual notes use PostgreSQL full-text search and pgvector for initial recall. Provider-accepted sends provide outcome evidence from the action ledger. The Memory tab exposes sources, corrections, expiry and removal. Expiry stops recall, while the review date surfaces entries for administrator attention. Per-agent maintenance applies the configured retention period to saved facts, notes and outcomes. It governs deletion of memory rows and relationship notes separately from their original channel records.

## 8. Native knowledge base and RAG

Each agent has a private document library for PDFs, Markdown, plain text, FAQs, product descriptions, brand materials and documentation. Files are stored in object storage; PostgreSQL stores ownership, extraction state, chunks, metadata and embeddings.

Upload flow: authenticate admin → upload original to RustFS (`agents/{agentId}/knowledge/{documentId}/…`) → create durable `knowledge_documents` row (`pending`) → enqueue `knowledge.process` on the Postgres job queue → worker extracts and cleans text → split into source-aware chunks (document, page/section, offsets) → embed via OpenRouter (AI SDK `embed`/`embedMany`, per-agent key then `OPENROUTER_API_KEY`) → store chunks and `vector(1536)` embeddings in PostgreSQL/pgvector → mark `ready` (or `failed`). Retries reuse embeddings already stored for unchanged chunk hashes so reprocessing does not re-pay completed vectors. Default embedding model is `openai/text-embedding-3-small` (`KNOWLEDGE_EMBEDDING_MODEL` / `KNOWLEDGE_EMBEDDING_DIMENSIONS` optional).

Retrieval: agent-scoped `knowledge.search` tool (read-only) runs hybrid search — pgvector cosine similarity plus Postgres full-text (`tsvector`/`ts_rank_cd`) — merged with reciprocal rank fusion, then returns source-labelled passages with citation metadata. Every invocation goes through the policy gateway. The agent Knowledge tab lists documents with status, supports upload/replace/reprocess/delete, and includes a retrieval inspector for query → ranked chunks, scores and match reasons.

Keep personality and operating rules in instructions, reference knowledge in RAG, and changing operational facts behind authenticated MCP/native tools. Support reprocessing, replacement, deletion and embedding invalidation.

## 9. Tool registry, MCP and real-world actions

Native tools and MCP operations share a typed capability registry. Examples include web.search, web.read, knowledge.search, x.reply, x.follow, email.send, calendar.schedule, people.search, people.introduce, task.schedule, support.createTicket and phone.call. Each agent explicitly enables the individual tools it may use.

Tools may complete synchronously or return a pending external identifier. Long-running work is represented as durable tasks with deadlines, wait conditions, status, retries and cancellation. Inbound webhook results are first persisted to PostgreSQL, then resume the task. The agent can make commitments that survive restarts.

Matchmaking is optional, not a universal agent feature. A superconnector can search profiles and propose mutually useful introductions; John can introduce an interested prospect to a demo host; Sarah can direct a customer to human support. Private introductions require consent appropriate to the information being shared.

Use natural-language guidance to describe when a tool is appropriate, but enforce permissions in deterministic code. Support per-tool automatic execution, approval-required execution or disabled state; record consent scope and evidence. For generic MCP, restrict exposed operations, credentials, timeouts and high-risk effects.

## 9a. Shared skill library and generic MCP connections

Orbit keeps reusable resources that are defined once and opted into per agent. Skills and MCP connections are workspace-scoped libraries, not per-agent copies. Agents reference them through join tables; deleting or editing a library record affects every attached agent on the next run. These are not separate runtimes—every agent still executes through the shared worker and policy gateway.

### Skill library

| Concern | Behaviour |
| --- | --- |
| Data model | `skills` stores a stable slug `name`, human title, short when-to-use `description`, Markdown `body`, integer `version` (incremented on each body/description change), `updated_at` and audit actor. `agent_skills` is the many-to-many opt-in. Names are unique workspace-wide. |
| Admin UI | Dedicated Skills list page (Templates-style disclosure rows) to create, edit and delete skills. Agent Access includes a multi-select picker of available skills. Secret material never appears in skill bodies intended for prompts. |
| Runtime loading | At run start the runtime loads only the agent’s selected skills. The system prompt receives a compact catalogue of **name + description** (progressive disclosure). Full Markdown bodies stay out of the default context. |
| Built-in tool | A first-party `load_skill` tool lets the model request one selected skill by name. The tool is read-only, subject to the same policy gateway, step budget and run deadline as other tools. It returns the body for that skill version and refuses skills the agent has not opted into. |
| Versioning / history | Each simulation result records which skill versions were attached and which were loaded (`skillVersions` / tool-call steps). Editing a skill bumps `version` so historical runs remain attributable to the version used at the time. |

### Generic MCP connections

| Concern | Behaviour |
| --- | --- |
| Data model | `mcp_connections` stores a unique `name`, remote `url`, transport (`http` or `sse`), optional encrypted auth headers (AES-GCM with the connection id as AAD, same master key as agent credentials), optional tool allowlist JSON, timestamps and actor. `agent_mcp_connections` opts agents in. |
| Admin UI | Dedicated MCP connections page to create/edit/delete connections and set headers without ever echoing stored secrets back. Agent Access includes a connection multi-select. Optional per-connection allowlists restrict which remote tools Orbit will register. |
| Runtime loading | For each selected connection the runtime opens an AI SDK MCP client (`@ai-sdk/mcp`) over HTTP or SSE, lists tools, applies the allowlist, and registers them into the model’s tool set for that run. Clients are closed when the run finishes. |
| Policy and safety | Every MCP tool invocation is typed as `mcp:<connection>:<tool>` (or an equivalent stable capability id) and must pass `authorizeAction`: enabled-tool checks, lifecycle, global pause (for non-read-only), budgets, approval tools, consent where applicable, and step limits. There is no bypass around the gateway. Tool arguments and results are untrusted content—they cannot change instructions, permissions or credentials. |
| Failure handling | Connection, handshake or discovery failures degrade that connection only: the run continues with remaining tools, and the result records a connection error entry. A denied or failed individual tool call is recorded as a tool step without aborting unrelated work. |
| Observability | Tool-policy steps and MCP/skill tool calls appear in run history. When Langfuse/Sentry telemetry is configured, the same correlation ids used for model stages cover tool spans and failures; secrets and auth headers are never logged. |

Administrators manage library records under global navigation; per-agent pickers only assign membership. Phase 4 delivery includes authenticated remote MCP; the skill library ships alongside it as shared prompt/tool infrastructure.

## 10. Communication and research integrations
| Integration | Initial role / approach |
| --- | --- |
| X | First social source and action channel; polling/mentions through approved API access. |
| Resend | Per-agent address on a dedicated subdomain; inbound webhooks, sending, replies, attachments, delivery outcomes. |
| Exa | Provider-independent web.search tool for research and discovery. |
| Firecrawl | Optional webpage extraction/crawling when basic web.read is insufficient. |
| MCP | Agent-scoped remote authenticated tools; Sentry, product data, CRM or custom systems. |
| Telegram | Future per-agent bot for external conversation and optional operator control. |
| Calendar | Availability, booking and invitations; explicit participant agreement. |
| SMS / voice | Future opt-in messaging and phone-call tools; asynchronous status handling. |
| Browserbase / Daytona | Optional isolated browser or code execution only when the capability genuinely requires it. |

Credentials are encrypted centrally and assigned per agent: separate OpenRouter, X and Telegram credentials by default. OpenRouter may also use an optional deployment-wide `OPENROUTER_API_KEY` environment default; a per-agent encrypted key overrides it at inference time without copying the env value into storage. The runtime retrieves secrets for authorised connectors; LLM prompts and tool responses never receive raw keys. Support rotation, revocation and degraded-connection status.

## 11. Scheduling and execution modes

Schedules are configured per agent for discovery frequency, query criteria, fetch limits, relationship reviews, follow-ups, memory maintenance and goal review. Durable jobs, not a perpetual LLM loop, drive work. LISTEN/NOTIFY improves latency but is not the queue; workers also poll for recovery.
| Mode | Reads | Writes |
| --- | --- | --- |
| Simulation | Saved events and mocked tools | Always mocked |
| Shadow | Real permitted reads and real model calls | All external writes suppressed and logged |
| Live | Real permitted reads | Only policy-approved actions; some may require human approval |

Normal channel runs can learn internally in shadow and live modes through the policy gateway. Playground and evaluation replays can read permitted memory and leave durable memory and outcome records untouched. Evaluation comparisons use a bounded, shared text-memory snapshot.

Pause and kill-switch controls must stop queued and in-flight outbound actions at the gateway where feasible. Use bounded model steps, timeouts, concurrency caps, cost limits, idempotency and reconciliation for ambiguous provider responses.

## 12. Evaluation, tracing and analytics

Use one Langfuse production project (and optionally a separate development project), not a project per agent. Tag traces with agent ID, execution ID, session/conversation ID, model, prompt/config version, tool, trigger and environment. Use Sentry for web and worker error monitoring and performance diagnostics, with correlation IDs linking failures to Orbit executions and Langfuse traces. Keep action status, delivery confirmation and approvals in Orbit PostgreSQL.
- Playground: paste a post or question, choose agent/model/version and inspect relevance, proposed actions, policy outcomes, source retrieval and draft responses.
- Regression datasets: save good/bad real-world events; compare model and prompt versions; replay events with no external writes.
- Evaluation types: deterministic assertions, LLM-as-judge for subjective qualities, and human review.
- Metrics: relevant opportunity rate, meaningful replies, meetings, support resolution, tool success, latency, cost, policy violations and opt-outs.
- Telemetry privacy: redact secrets and sensitive personal data from Langfuse and Sentry; apply retention and access controls.

## 13. Dashboard and administration

Global navigation: Agents, Activity, Approvals, Conversations, People, Playground/Evaluations, Skills, MCP connections, Integrations and Settings. Each agent has Overview, Identity/Personality, Mission/Goals, Models, Tools, Triggers, Channels, Knowledge, Memory, Activity, Conversations, Analytics and Permissions. Skills and MCP connections are managed as shared libraries and attached per agent from Access.

Admin access initially uses environment-configured email/password credentials; trusted OAuth with allowlisted emails is planned. No open registration. The dashboard provides per-agent pause/resume, shadow/live mode, credential health, a global Approvals inbox with a pending-count badge, usage and action audit trails.

## 14. Suggested data domains (not a fixed schema)

Agents and versions; templates and campaigns; credentials and integrations; shared skill library and agent–skill membership; generic MCP connections (encrypted headers, allowlists) and agent–connection membership; inbound events and evaluations; jobs, tasks and actions; people, identities, follows, conversations and messages; consent and blocklists; knowledge documents, chunks and embeddings; memory objects; execution traces and evaluation cases; approvals, schedules and budgets.

Every agent-owned record needs an explicit agent scope; shared or cross-agent access must be intentional. Add unique provider-event keys and outbound idempotency keys. Store provider payloads alongside normalised fields when allowed by provider retention terms.

## 15. Full product scope and incremental delivery

Orbit's **full platform design is the implementation backbone**. Delivery is incremental, but architecture and data models must accommodate the full system without redesign. The first completed release is Railway-deployable and supports real external actions where provider access and policies permit; unavailable provider capabilities are explicitly disabled rather than faked.

| Phase | Outcome |
| --- | --- |
| 1. Foundation | Private environment-configured administrator login and guarded local development AUTH_DISABLED bypass; OAuth and magic-link login and allowlist later, agents/templates, versioned configuration, optional OpenRouter env default plus encrypted per-agent credential overrides, Drizzle/Postgres, Zod environment validation, Docker/Compose/Railway configuration. |
| 2. Runtime and safety | Bun worker, durable jobs and recovery, OpenRouter/AI SDK, model configuration, policy gateway, human-in-the-loop approval queue with run suspend/resume, hard budgets, consent, agent lifecycle, Langfuse traces, Sentry monitoring and audit trails. |
| 3. Evaluation and UI | Full agent workspace, playground for single inputs and multi-step scenarios, simulation and shadow mode, detailed timelines, production-derived regression datasets and side-by-side comparisons. |
| 4. Channels and research | Approved X discovery, mentions, posting and other permitted actions; Resend virtual inboxes; web search and read; shared skill library (progressive disclosure + `load_skill`) and admin-defined generic MCP connections (HTTP/SSE) selected per agent, with all remote tools gated by the policy gateway. |
| 5. Intelligence and memory | Cheap multi-action evaluator, adaptive context retrieval, proactive planning, conversations, structured and JSONB memories, reversible identity linking, agent-scoped and shared-library RAG with pgvector. |
| 6. Durable outcomes | Future tasks, event-driven waits, follow-ups, channel approval pings (Telegram/Slack), evidence-based outcomes, introductions, relationship review and escalation. |
| 7. Validation and live readiness | Exercise all six templates plus blank agent, with detailed end-to-end tests for John, Sarah and the superconnector. Verify evaluations and safeguards, then require explicit administrator activation for live mode. |

These are implementation milestones, not independent product architectures. Codex may refine sequencing and engineering choices while preserving the behavioural requirements.

### Agent templates

All templates are editable database-backed presets with personality, mission, instructions, suggested tool groups, schedules, policies, engagement criteria and evaluation fixtures. They are **not** separate agent implementations.

| Template | Example mission |
| --- | --- |
| Sales and GTM — John | Represent The Timeline, discover potential customers, conduct relevant outreach, build relationships and arrange demos with a human. |
| Customer support — Sarah | Answer product questions from RAG, investigate with approved MCP tools and escalate to human support when needed. |
| Superconnector | Learn consenting participants' needs and offers, identify useful matches, seek double opt-in and arrange introductions. |
| Community manager | Welcome members, participate in authorised communities, answer questions and facilitate discussions. |
| Recruitment agent | Research suitable candidates, communicate within applicable permissions and coordinate hiring conversations. |
| Partnerships agent | Discover compatible organisations, assess collaboration opportunities and coordinate partnership discussions. |
| Blank agent | Start without predefined mission, personality or tools. |

Event coordination and research may be added as further templates without new runtime types.

## 16. Deferred capabilities and non-goals
- No public SaaS billing, tenant onboarding or marketplace in the first version.
- No visual workflow designer, complex agent-to-agent handoff framework or bespoke agent implementations.
- No full-time sandbox/container per agent; add isolated browser/code tools only when needed.
- No requirement to activate voice, SMS, Instagram, Reddit, Bluesky or WeChat in the initial integration rollout; adapter architecture must support them later.
- No assumption that automated engagement is permissible merely because an API endpoint exists.

## 17. Implementation defaults and safeguards
- X integration: use only authorised API capabilities and approved automation. Missing permissions disable affected tools and leave the agent functional in shadow mode; do not implement scraping as a fallback.
- Jobs: use a PostgreSQL-backed durable queue with transactional enqueue, SKIP LOCKED claims, leases, retries, dead-letter state and periodic recovery polling. LISTEN/NOTIFY is an optional wake-up optimisation, never the sole delivery mechanism. Codex chooses a maintained library or a small implementation that satisfies these recovery semantics.
- External writes: store an action intent and idempotency key before dispatch. If the provider response is ambiguous, reconcile the provider state before any retry. Preserve the complete audit trail.
- Tool policies allow read-only tools to execute automatically within budgets. Public posting and relationship actions require explicit per-agent enablement and platform permission. Administrators opt in to review per agent and action, including for introductions and escalations. Recipient consent is an independent check. Each agent can require recorded consent for introductions and escalations separately. Honor recorded refusals, revocations and applicable privacy and consent requirements. Enforce these checks in deterministic code.
- Knowledge files: use RustFS through its S3-compatible API for originals and attachments; PostgreSQL holds metadata, extraction state, text chunks and pgvector embeddings. Initially accept PDF, TXT and Markdown. Expand formats through extractors without changing the core data model.
- Budgets: every agent has configurable daily and monthly OpenRouter spending caps, provider request quotas, outbound-action caps, concurrency limits, a maximum of 10 tool steps per run and a five-minute run deadline as initial defaults. Reject or defer work when limits are reached; do not treat limits as activity targets.
- The workspace shares the People identity graph. Evidence-backed links can be inferred, confirmed and reversed. Agent memory, evidence, conversations, relationship history and credentials stay private to the owning agent at runtime. A People link grants neither access to another agent’s records nor consent to disclose them. Knowledge is private by default. Administrators can grant agents access to shared libraries.
- Email: use Resend for outbound sending and inbound routing to agent-specific addresses on a dedicated subdomain, with PostgreSQL-backed virtual inboxes. Validate provider account features, domain verification, webhooks and deliverability during integration; use supported APIs only. If an account lacks inbound access, keep email receiving disabled until enabled rather than changing the architecture.
- Operational security: allowlisted administrator login, encrypted per-agent credentials (with optional env-only provider defaults that are never logged or prompted), audit logs, webhook signature verification, prompt-injection boundaries, opt-out enforcement and a global outbound kill switch are required for live mode.

## 18. Detailed behavioural requirements

### 18.1 Discovery and evaluation
- Each agent can define multiple discovery sources, schedules, administrator-authored keywords/search expressions, account lists, language or topic constraints, fetch limits and natural-language engagement criteria. Agents may generate operational search queries within those constraints but cannot modify saved configuration. These are configuration, not hard-coded agent types.
- The discovery adapter persists source events and provider identifiers first. A shared fetcher may reuse permitted reads for multiple agents, but evaluations, action proposals and relationship histories remain agent-scoped. Respect provider retention and redistribution rules.
- Run deterministic exclusions before any model call: blocked people, opt-outs, spam, repeated tags, duplicate posts, already-handled conversations, disabled tools, rate limits and source-specific rules.
- The inexpensive evaluator returns relevance, priority scores, reasons and **zero, one or many** candidate actions on a single event (reply, like, repost, follow, bookmark, ignore and platform-specific actions). It is not the final authority to execute. A negative or uncertain assessment may result in no main-agent invocation. Use adaptive context retrieval: start with the event, fetch parent/thread context when needed. The main agent selects from ranked opportunities.
- The main agent can revise or combine suggestions; every actual action is independently checked and recorded. Support audience/post filters such as verified status, follower count, language, original reply-count snapshot and account exclusions. Allow scheduled original posts, with optional media tools. Configure whether and when agents continue replies to their own posts or replies. A failed action does not necessarily cancel other independent actions.

### 18.2 Relationships, following and unfollowing
- Record the reason, originating interaction, time and status for every follow; maintain relationship notes, prior conversations, contact preferences and opt-outs.
- A configurable scheduled review examines followed accounts for relevance, relationship history, inactivity, explicit requests and cooldowns. It proposes unfollows rather than relying on opportunistic decisions during unrelated conversations.
- Never treat lack of engagement alone as a reason for aggressive follow/unfollow cycling. Apply provider restrictions and conservative limits.
- Agents act independently by default. Prevent the same agent accidentally repeating the same action on the same target; a separate agent may engage independently. Offer a per-agent setting to avoid posts already engaged by other Orbit agents. Conversation continuation is not a duplicate of initial engagement.

### 18.3 Communication, introductions and meetings
- Resend-backed virtual mailboxes support inbound and outbound mail, drafts, replies, attachments, delivery/bounce status, subject lines, Message-ID, In-Reply-To and References for threading, and search in Orbit's own stored messages.
- A person may have multiple platform identities; link identities autonomously using evidence and confidence, with verified and inferred states, reversible links and automatic rollback when contradicted. A phone number supplied in conversation is strong evidence but not proof of ownership. Never use an inferred link to bypass sharing permissions. Maintain a coherent relationship history when authorised identity linkage exists.
- Introductions are an **optional toolset**. A superconnector may search consenting profiles and match needs to offers; a sales agent may offer a demo introduction; a support agent may introduce a human support contact. The agent type does not determine which tools exist.
- The introduction lifecycle is: identify a useful connection → propose it → collect each required party's consent → share only authorised information → send the introduction → optionally arrange a meeting → record the outcome and follow-up.
- Support calendars, SMS and voice as future tools. Outbound messages, calls, bookings and personal-data sharing must honour consent and any required administrator approval.
- Agents may refer to other agents using their public handles or email addresses. No special internal handoff framework is required.

### 18.4 Durable commitments and tool outcomes
- Agents can create future commitments such as “follow up next Tuesday”, “check whether a support issue is resolved”, “wait for a reply”, or “book a demo after confirmation”. Persist the owner, next run time, status, dependencies, attempts and cancellation state in PostgreSQL.
- Tool results can be immediate, failed or pending. Pending work resumes only after a persisted provider callback, inbound event or scheduled check. Never rely on an LLM process remaining alive while waiting.
- A generic tool registry exposes native tools and individually allowlisted remote MCP tools, including their input schemas, authentication requirements, permissions and side effects. Tool availability is agent-specific; adding a new tool does not require a new agent type.
- MCP tools and retrieved content are untrusted inputs. Use explicit credentials, timeouts, scope restrictions, audit records and stronger isolation for executable/untrusted tools.

### 18.5 Playground, evaluation and trace inspection
- The dashboard playground supports pasting an X post, selecting a saved event, simulating an inbound email or supplying a custom scenario. Select agent, configuration version, evaluator model and main model.
- Show deterministic filter decisions, evaluator scores and proposed **multiple actions**, generated drafts, retrieved knowledge passages, tool-call sequence, permission decisions, simulated effects, token/cost estimates and links to Langfuse traces.
- Simulation never makes external writes. Shadow mode may perform permitted reads and real LLM inference, but writes are suppressed centrally. Live mode permits only explicitly enabled and authorised operations.
- Turn real successes and failures into replayable evaluation cases. Compare prompt/model versions with fixed inputs and mocked side effects; retain historical results for regression testing.
- The activity timeline is per agent and includes discovery, evaluation, planning, action intent, execution outcome, follow-ups and errors. Langfuse stores diagnostic traces; PostgreSQL remains authoritative for action and task state.

### 18.6 Knowledge and model configuration
- Store personality, mission, operating instructions, engagement criteria, tool-use guidance and schedules separately as versioned text/configuration. Templates are editable defaults, not separate implementations.
- Allow an optional deployment-wide OpenRouter environment default, per-agent encrypted key overrides, and independently configurable main and evaluator models, with budgets and fallback/error behaviour. Never expose raw provider keys to model prompts.
- Agent-scoped document uploads include PDF, TXT and Markdown initially; support FAQs, product documentation and brand guidance as content. Originals live in object storage; extracted chunks, metadata and embeddings live in PostgreSQL/pgvector.
- Retrieve relevant passages rather than placing entire documents in the system prompt. Show citations/sources and retrieved chunks in the dashboard. Use native/MCP tools for live operational facts rather than treating static RAG as authoritative for changing data.

### 18.7 Human-in-the-loop approvals
- Approval rules are **disabled by default**. Empty per-agent `approval_tools`, empty global `controls.approval_tools` and a null spend threshold leave behaviour unchanged aside from the existing introduce/escalate consent+approval product rules.
- Rules are simple toggles/lists per agent (and optionally global): action types such as outbound DM/public post analogues (`reply`, social writes), named tool calls (including future MCP tool names), and an optional spend-above-threshold gate. There is no rules DSL.
- Gateway outcomes remain `allow | deny | needs-approval | suppressed`. `needs-approval` is a first-class third path for consequential writes.
- Suspension state machine: `queued → running → awaiting_approval → running → completed|failed|interrupted`. While `awaiting_approval`, the linked queue job is completed/released; workers hold no lease. Resume creates a new job that continues from the durable simulation checkpoint so paid model stages are not redispatched.
- Pending actions persist on `action_intents` (agent, run, action type, proposed payload, review status, optional `review_expires_at`, reviewer). Resolved items remain visible in history. Administrators may approve, edit-then-approve, reject, or bulk approve/reject from the Approvals inbox; a nav badge shows the pending count; the list filters by agent.
- Reject feedback is written into the intent/decision trail so the resumed run sees the decline. Per-agent `approval_on_reject` is `continue` (default) or `end`. Optional expiry auto-rejects stale pending items during worker reconcile.
- Record decisions in run history, `policy_decisions`, administrator audit rows and Langfuse span events when observability is configured. A `notifyApprovalPending` hook is reserved for Telegram/Slack; do not implement those channels yet.

### 18.8 Operations and administration
- An environment-configured administrator can sign in with email and password; future OAuth or magic links require allowlisted administrator emails; there is no public registration. AUTH_DISABLED is allowed only in a strictly local development environment and must fail startup in production; use an explicit local admin identity. Each agent has its own connections, credentials, permissions, execution mode, schedules, memory, knowledge and budgets.
- Support agent pause/resume, global outbound kill switch, per-tool approval policies, provider health/degraded states, secret rotation and revocation, and comprehensive audit history.
- Support a dedicated per-agent email address, social identity and (later) Telegram bot. A single codebase and shared Bun worker execute all agents; no per-agent deployment or sandbox is required for trusted API tools.
- Keep Orbit lightweight: one Next.js app, one Bun worker, PostgreSQL/pgvector, Railway/Docker (Dockerfiles, Docker Compose and per-service railway.json), Zod-validated environments, and hosted providers. Do not add Go, Redis, Kafka, a visual workflow editor or a separate orchestration service for the MVP.

## 19. Decisions from product review (rounds 1–8)

### Identity, autonomy and planning
- One agent may operate multiple connected identities and channels, sharing its own agent-scoped relationship memory while keeping platform-specific threads intact.
- Only administrators edit persistent configuration: prompts, personality, mission, saved discovery criteria, tool grants, models, schedules and budgets. Agents may create plans, operational queries, memories and future tasks within that configuration.
- Proactive planning and autonomous first contact are supported where legally and contractually permitted. Each agent's first-contact policy is `auto`, `approval` or `disabled`, with tool-level overrides. Automatic first contact is the default setting, never a bypass of platform restrictions.

### Discovery and independent engagement
- Cheap evaluation returns relevance, candidate actions and scores. Retrieve additional context adaptively. The main agent selects from ranked opportunities and may perform multiple independently authorised actions on one post.
- Agents act independently. Per-agent deduplication prevents repeated initial actions from reprocessed events. Other agents may engage the same post unless an individual agent's cross-agent-engagement exclusion is enabled.
- Support original publishing, scheduled posts, per-agent audience filters (including verified accounts and initial zero-reply posts), and configurable conversation continuation after inbound replies.
- Outcomes can be retrieved as memory and influence reasoning, but agents do not silently change saved configuration or permissions.

### Memory, people and knowledge
- Agent memories are isolated by default; knowledge libraries may be private or explicitly shared. Memories include structured facts and controlled flexible JSONB objects with provenance.
- Retention is configurable by data class, with deletion and provider requirements taking precedence.
- Identity linking is autonomous, evidence-based and reversible; confirmed links and inferred links are distinguished. No admin review is required for every match, but identity linkage never implies consent to disclose data.
- Essential current conversation context is loaded automatically; agents can call deeper memory, history and RAG retrieval tools when needed.

### Tools, consent and durable tasks
- Tool groups are enabled per agent, with individual overrides. Remote authenticated MCP servers expose discoverable, individually controlled operations.
- An agent's instructions can guide when it proposes an introduction or escalation. Administrator review is a separate per-action setting. Recipient consent is structured, scoped and supported by conversation evidence.
- Tools can return immediate results or pending states represented by durable tasks. Tasks resume on persisted events or timeout checks.
- Conversations remain separate per channel/thread with linked person context. Every inbound reply is evaluated; agents may autonomously schedule bounded follow-ups, recover from failures and escalate when necessary. Completion is evidence-based, not an agent assertion.

### Testing, operations and live activation
- The native playground supports quick inputs and multi-step scenarios using the production runtime with mocked or suppressed writes. Evaluation datasets are manually authored or promoted from production traces.
- Evaluations combine deterministic assertions, model judges and human feedback. Administrators can rate, correct and save regression cases, and compare model/prompt versions side by side.
- Orbit shows detailed execution timelines, operational metrics and goal outcomes; Langfuse stores diagnostic traces, not the authoritative job/action ledger.
- Authentication initially supports environment-configured administrator credentials, with OAuth and magic links with allowlisted emails planned; local-only `AUTH_DISABLED` bypass is explicitly guarded. Per-agent secrets are encrypted in PostgreSQL with an external master key; optional provider defaults such as `OPENROUTER_API_KEY` may live only in the process environment. Zod validates environment configuration.
- Web + worker + PostgreSQL deploy on Railway with Docker, Compose and per-service Railway config. Both images ship `scripts/migrate.ts` and `apps/web/drizzle/`; Railway `preDeployCommand` and process startup apply pending migrations under `pg_advisory_xact_lock` before serving traffic or claiming jobs. RustFS provides S3-compatible object storage for files on a persistent volume; back up object data alongside PostgreSQL references. Jobs recover with reconciliation, integration failures degrade only affected capabilities, hard per-agent budgets apply, and automated backups are periodically restore-tested.
- Evaluation and safety checks must pass before live activation, but **only an administrator** can enable live mode, pause, resume or stop an agent. The first complete release must support permitted real external actions, not merely a shadow demo.

## 20. Definition of success

Orbit succeeds when an administrator can create John, Sarah or a superconnector from a template, configure personality and mission in plain language, assign separate models and tools, attach documents, schedule discovery, run a shadow-mode test, inspect evaluations and Langfuse traces, and deliberately activate live operation after checks and evaluations. Admins can pause, resume and stop agents; stop prevents further external writes and cancels pending work where feasible. All live actions remain individually policy-gated. The same runtime must support both proactive outreach and reactive support, with durable follow-through on commitments.

Guiding statement: Agents decide what to do. Tools define what they can do. Policies determine what they may do. Tasks ensure they follow through. PostgreSQL records what actually happened.

### Initial administrator password authentication

MinIO-style bootstrap credentials are supplied through `ORBIT_ADMIN_EMAIL` and `ORBIT_ADMIN_PASSWORD` (minimum 16 characters), never committed or exposed to clients. `APP_URL` defines the trusted origin; production deployments require HTTPS. No public registration or password-reset flow is exposed. Rotate the password in the deployment environment; rotation invalidates existing sessions. OAuth and magic links remain planned additions, not prerequisites for the foundation.

Use cryptographically random, eight-hour, database-backed opaque sessions; PostgreSQL stores only token hashes and credential fingerprints. Cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. Server mutations verify the origin and administrator session. Login attempts are limited durably in PostgreSQL (ten attempts per fifteen minutes for the bootstrap account); account-wide throttling deliberately trades availability for brute-force resistance without trusting proxy headers. Password comparison uses constant-time digests. Agents default to the `shadow` lifecycle with a global outbound pause enabled. The policy gateway enforces the pause, lifecycle, tool enablement and budgets before any dispatch. Channel integrations and OAuth remain deferred.

### Phase 2 implementation decisions (Runtime and safety)

Recorded so later phases can extend without redesign:

1. **Durable job queue — small shared module, not an external library.** Orbit needs transactional enqueue inside the same Drizzle/PostgreSQL transaction that writes the creating row (for example a `simulation_runs` insert). Maintained libraries such as pg-boss and Graphile Worker own their connection pools and make that pattern awkward under Bun + Drizzle. The queue lives in `apps/web/src/lib/queue` with `FOR UPDATE SKIP LOCKED` claims, leases and heartbeats, exponential backoff retries, a `dead` status, periodic expired-lease recovery, idempotency keys and graceful SIGTERM drain. LISTEN/NOTIFY is intentionally omitted; polling is the delivery mechanism and may gain NOTIFY later only as a wake-up optimisation.

2. **Unified agent lifecycle.** The previous `status` (`paused`/`active`) plus `mode` (`simulation`/`shadow`/`live`) pair is replaced by a single `lifecycle` column: `shadow` (default), `paused`, `live`, `stopped`. Only administrators may change it; every change is audited. Stop cancels pending jobs where feasible and blocks further external writes. Live is a first-class state but remains gated: no external action adapters exist yet, so the policy gateway still suppresses proposals and the UI says so plainly. Manual Playground simulations may enqueue while the agent is in `shadow` or `live`. Agents in `paused` or `stopped` reject new manual runs.

3. **Shared runtime modules.** Framework-independent execution, queue, policy, budgets, schema and `db` stay under `apps/web/src/lib` and are imported by the Bun worker via `@/*` → `apps/web/src/*`. The worker validates `DATABASE_URL`, optional `ORBIT_ENCRYPTION_KEY` and optional `OPENROUTER_API_KEY` without loading admin auth env. OpenRouter key resolution remains agent credential → `OPENROUTER_API_KEY` → inspectable failure on both web and worker paths.

4. **Policy gateway as the single choke point.** Every candidate action records an `action_intents` row with an idempotency key and a `policy_decisions` audit row before any dispatch would occur. Outcomes are `allow`, `deny`, `needs-approval` or `suppressed`. Administrator review defaults off and applies only to actions the administrator selects for that agent. Introductions and escalations each have a recipient consent setting that defaults on. A recorded refusal or revocation blocks the matching action. With no write adapters, non-read-only actions end suppressed (or denied for pause/lifecycle/tool/budget reasons) unless a human-approval rule fires first; approved proposals and proposals that need no review remain suppressed until write adapters exist.

5. **Hard budgets.** Per-agent JSON budgets default to architecture §17 values (including 10 tool steps and a five-minute run deadline). If either the daily or monthly spend cap is enabled, the worker requires verified OpenRouter pricing before inference and reserves spend against the enabled caps. When both spend caps are disabled, inference can proceed without a price quote. Request, concurrency, outbound, step and deadline caps still apply. Limit hits reject or defer work and surface in run history.

6. **Human-in-the-loop approvals (optional, disabled by default).** Configurable approval rules are off until an administrator enables them. With empty per-agent and global approval-tool lists and no spend threshold, write proposals follow the existing suppress/deny path except for product-mandated introduce/escalate consent+approval. When a main-stage action evaluates to `needs-approval`, the runtime persists the pending intent, marks the run `awaiting_approval`, checkpoints simulation progress (including paid-stage burn markers) and completes the queue job so no worker lease is held. Approve (optionally with an edited payload) or reject records the decision, audits it, emits a Langfuse span event when telemetry is configured, and re-enqueues the run to continue from the checkpoint without redistributing paid model calls. Reject may continue or end the run per agent setting. Optional per-intent expiry auto-rejects stale items. A no-op notifier hook is reserved for later Telegram/Slack pings; channels are not built in this phase. The Approvals inbox lists pending and resolved items across agents.

7. **Observability is optional and off the correctness path.** `@sentry/nextjs` (App Router: `instrumentation.ts`, client/server/edge config, `global-error`) and `@sentry/bun` capture application errors and performance. Langfuse receives agent traces through the Vercel AI SDK `telemetry` option (AI SDK 7’s name for `experimental_telemetry`) and `@langfuse/otel`’s `LangfuseSpanProcessor`, with spans for evaluator/main model calls, policy gateway decisions, budget checks, tool-policy steps and approval decisions. Prompt/model content is omitted unless `LANGFUSE_CAPTURE_CONTENT=true`. A shared redaction layer strips secrets and refuses untrusted content as tags. Missing `SENTRY_DSN` / `LANGFUSE_*` disables exporters with no network calls. Source map upload requires `SENTRY_AUTH_TOKEN` and must not fail the web build when absent. Exporter failures are swallowed. PostgreSQL remains operational truth.


### Guarded local development authentication

`AUTH_DISABLED=true` is implemented for local development only. Require `NODE_ENV=development`, loopback app and PostgreSQL URLs, and an explicit `AUTH_LOCAL_ADMIN_EMAIL`. The supported `bun run dev` launcher binds the web process to 127.0.0.1 and supplies an internal runtime marker; direct Next invocations do not enable bypass. Reject invalid flags and unsafe bypass configuration at startup, including in production. Also check the request Host against APP_URL and retain origin validation on mutations. Do not expose this server through a proxy or tunnel. This mode creates no sessions, uses the explicit local identity for all audit records, redirects /login to the dashboard and displays a persistent bypass notice. Authentication remains enabled by default; disabling the flag restores the administrator password requirements. OAuth/magic-link login remains deferred.
