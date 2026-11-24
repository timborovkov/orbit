# Durable outcomes checklist

## Reply-aware commitments

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
- [x] Land [reply-aware commitments](https://github.com/timborovkov/orbit/pull/57)
      on `main` with the shared lifecycle registration.
- [ ] Land [Firecrawl web research](https://github.com/timborovkov/orbit/pull/54)
      on `main`.

## Consent-based introductions

See [consent-based introductions](docs/introductions.md) for the workflow and
acceptance checks.

- [x] Let agents with the People introduction grant propose matches using
      profiles from their own observations.
- [x] Show the planned disclosure and record each participant’s decision on
      that proposal. Prepare one draft after both agree.
- [x] Verify refusals, revocations after approval, disclosure rechecks, and
      isolation across linked identities.
- [x] Land [consent-based People introductions](https://github.com/timborovkov/orbit/pull/56)
      on `main`.

## Replies to discovered X posts

- [x] Persist one editable proposal for an eligible discovered post in Shadow.
- [x] Support administrator review and automatic Live delivery under a standing
      channel grant. Recheck policy at dispatch and show the result in Activity.
- [x] Verify replay, duplicate discovery, delivery retry and pause with the
      fixture worker. [X reply runbook](docs/x-discovery-replies.md)
- [ ] Verify delivery on the hosted deployment with a user-context credential
      for an X-approved account and a controlled post whose author invited a reply.
