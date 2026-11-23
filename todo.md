# Durable commitments checklist

The [architecture](architecture.md#184-durable-commitments-and-tool-outcomes)
owns the product scope. [Durable follow-ups](docs/follow-ups.md) describes the
workflow, shared worker interface and verification.

- [x] Give each agent independent opt-in grants to schedule a follow-up or wait
      for a reply in a saved conversation.
- [x] Resolve waits through shared channel intake and continue with the saved
      reply. Queue one reviewable draft when the deadline wins.
- [x] Show outcomes and evidence in Activity. Support cancellation and enforce
      pause and stop for pending work.
- [x] Cover Sarah’s reply, timeout, duplicate delivery, worker restart and
      deadline race with regression tests.
- [x] Verify the shared job lifecycle with Firecrawl. Orbit closes the
      commitment on pause or stop while Firecrawl confirms provider cancellation.
- [x] Land reply-aware commitments on `main` with the shared lifecycle registration.
      [PR #57](https://github.com/timborovkov/orbit/pull/57)
- [ ] Land [Firecrawl PR #54](https://github.com/timborovkov/orbit/pull/54)
      on `main` with the shared lifecycle registration.

## Replies to discovered X posts

- [x] Persist one editable proposal for an eligible discovered post in Shadow.
- [x] Support administrator review and automatic Live delivery under a standing
      channel grant. Recheck policy at dispatch and show the result in Activity.
- [x] Verify replay, duplicate discovery, delivery retry and pause with the
      fixture worker. [X reply runbook](docs/x-discovery-replies.md)
- [ ] Verify delivery on the hosted deployment with a user-context credential
      for an X-approved account and a controlled post whose author invited a reply.
