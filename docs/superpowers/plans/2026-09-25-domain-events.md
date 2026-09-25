---
title: Domain event bus implementation plan
description: Plan for the first part of issue #112 — mocco_domain_events and its delivery ledger, the @mocco/common/events catalog, EventBus with per-subscriber events.deliver jobs, events.prune, and the governance events published by RunService and GateService.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, events, platform, governance]
implements: ../../adr/0018-domain-events-vs-audit-log.md
related:
  - ../../specs/2026-09-24-platform-foundations-design.md
  - ../specs/2026-09-25-notification-relay-design.md
  - ../../reference/events.md
  - ../../reference/jobs.md
  - ./2026-09-25-job-queue.md
---

# Domain event bus — implementation plan

**Goal:** let other domains react to runs and gates without polling (platform foundations §15,
issue #112). This slice ships the bus, the catalog and the governance events; notifications (#117)
are the first consumer. Stacked on the job queue (#250, migration 0013), so it ships migration 0014.

**Architecture:** `EventBus.publish` validates the payload against the `@mocco/common/events`
catalog, inserts a `mocco_domain_events` row, and enqueues one `events.deliver` job per matching
subscriber (`dedupe_key = <eventId>:<subscriber>`, kicked). The handler calls the subscriber and
records `(event, subscriber)` in `mocco_domain_event_deliveries`, so a second job for the same pair
is a no-op. Governance publishes after its state change through `publishBestEffort`.

## Tasks

- [x] Catalog in `@mocco/common/events`: `GovernanceEventTypes` + payload schemas, assembled into
      `DomainEventTypes` / `domainEventPayloadSchemas` (the extension point), `isEventPatternMatch`.
- [x] Schema + migration 0014: `mocco_domain_events` (seq unique, workspace FK, project composite
      FK, `(workspace_id, occurred_at)`, `(type, occurred_at)`, `occurred_at`, partial unique
      `(workspace_id, dedupe_key)`) and `mocco_domain_event_deliveries`.
- [x] `DomainEventRepo`: deduped insert, find, ledger check/mark, prune by `occurred_at`.
- [x] `EventBus`: `subscribe` (exact or `prefix.*`, unique names), `publish`, `deliver`.
- [x] `domain/events/jobs.ts`: `events.deliver`, `events.prune` (daily platform schedule),
      `createEventHandlers`, registered in `runtime/jobs.ts`.
- [x] Composition: `createEventBus` (the one subscriber list) used by `getEventBus()` and by
      `runtime/jobs.ts`; execution and governance roots inject `getEventBus()`.
- [x] Governance: `run.succeeded` / `run.failed` in `RunService.finishRun`, `gate.pending` in
      `advance`, `gate.resumed` (before the run continues) and `gate.rejected` in `GateService`.
      Payloads carry repo, pipeline, commit, run page path and filterable facts.
- [x] Tests (pglite): fan-out and wildcards, dedupe key, payload validation, once-per-pair delivery,
      retry on subscriber error, pruned-event delivery, prune; governance events and a failing bus.
- [x] Docs: ADR 0018, `reference/events.md`, composition notes in `reference/jobs.md` and backend
      conventions.

## Deferred

- The 16 inbound event types: they come from `@mocco/common/inbound` (#249), which is not on this
  branch. They join the catalog through the extension point.
- `deploy.released`, `mocco_releases` and its reconciling schedule (rest of #112).
- An outbox (publish in the state change's transaction via `executor: tx`), which would close the
  crash window between a state change and its publish.
- The other foundations types (`domain.activated`, `jobs.dead`, `enduser.merged`).
