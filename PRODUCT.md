# Orbit product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

A private administrator creates independent AI agents, configures their behaviour,
and compares their responses to pasted posts or questions. The authoritative product
and infrastructure specification is [architecture.md](architecture.md).

## Capabilities and constraints

Administrators manage versioned agent configurations, reusable templates, Skills,
MCP connections, shared Knowledge, People and agent-private Memory. They can run
Playground simulations and compare saved evaluations. Background work, read-only
tools, outbound approvals and lifecycle controls use the shared policy and queue.

Orbit supports X discovery and administrator-approved email replies. Firecrawl
provides independently granted web search, page reads and bounded crawls.
Operators inspect progress and citations in Activity and can explicitly import
saved pages into a shared Knowledge library. Provider activity, availability and
successful actions displayed in the console come from recorded results.

Administrators can grant an agent permission to schedule a follow-up or wait for
a reply in a saved conversation. Activity records the deadline, outcome and
evidence. A deadline can produce a draft for administrator review. See
[durable follow-ups](docs/follow-ups.md).

## Confirmed commitments

Use the Orbit logo, IBM Plex typography, light/dark/automatic appearance and responsive
web controls. The user rejected the original workspace's visual treatment and long
form on 16 November 2026 and requested a redesign using Impeccable. The user selected
“Both: rethink the layout and visual treatment.” Design decisions and verification
remain in the repository's single [design.md](design.md) reference.
