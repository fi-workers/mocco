---
title: Inbound sources service implementation plan
description: Plan for the second notification relay slice of #243 — the inbound event catalog, mocco_inbound_sources and mocco_inbound_receipts, SourceService and InboundService on top of the pure adapters, the republish and prune jobs, the ingest route and the inbound tRPC router.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, notifications, inbound, webhooks]
implements: ../../adr/0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md
related:
  - ../specs/2026-09-25-notification-relay-design.md
  - ./2026-09-25-inbound-adapters.md
  - ./2026-09-25-domain-events.md
  - ../../reference/inbound.md
---

# Inbound sources service implementation plan

Part of #243 (notification relay, build step 6), stacked on the domain events slice (#254) and the
pure adapters (#249). Design: notification relay spec §4, §5, §9, §13.

## 1. Catalog (`@mocco/common/events`)

- `inboundEventPayloadSchema = { sourceId: uuid, facts, message: NeutralMessage }`, one schema for
  all sixteen `InboundEventTypes`, added as the `inbound` area (`inboundEventPayloadSchemas`) and
  spread into `DomainEventTypes` / `domainEventPayloadSchemas`.
- Test: every inbound type is in the catalog and maps to the shared schema.

## 2. Wire types (`@mocco/common/inbound`, `@mocco/common/workspace`)

- `InboundSourceStatuses`, `InboundOutcomes`, the source and receipt DTOs, the create input, the
  receipts query and page.
- `WorkspaceMemberRoles` (owner, admin, member) for the write check.

## 3. Migration

`mocco_inbound_sources` and `mocco_inbound_receipts` per spec §5, with a composite FK pinning a
receipt to its source's workspace, the quota index (published, by workspace and time), the stale
pending index, the prune index and the `domain_event_id` index for the `SET NULL`.

## 4. Adapters

Add `sourceEvent(rawBody, headers)` to each adapter (the receipt's `source_event`) and a registry by
kind (`sources/adapters.ts`).

## 5. Services (TDD on pglite, real SecretBox, real event bus)

- `SourceService`: create (pasted secret for Sentry/Vercel, generated for GitHub and returned
  once), list with `hasSecret` and `ingestUrl`, rename, pause/resume, rotateSecret, delete.
- `InboundService.ingest`: the seven steps of spec §5, never throwing for vendor input.
  `republishStale`, `pruneReceipts`, `listReceipts`.
- Tests: 401 with zero writes per kind, 404 unknown/paused, 400 without a delivery id, redelivery
  dedupe, ignored reasons, invalid UTF-8, BOM, quota, publish linkage, pending on a failed publish,
  republish (including a race with an original that already published), prune, tenant isolation,
  no secret in any row or log line.

## 6. Jobs

`domain/inbound/jobs.ts`: `inbound.republish-stale` (60 s) and `inbound.prune` (daily) as platform
schedules, registered in `runtime/jobs.ts`. The runner's InboundService resolves the SecretBox only
if a secret is opened, so it builds without `SECRETS_ENCRYPTION_KEYS`.

## 7. Transport

- `transport/ext/inbound.ts`: `POST /inbound/:ingestKey`, bytes via `arrayBuffer()`, fixed bodies,
  503 when unconfigured, bare 500 on an unexpected error. Mounted in `app.ts`.
- `inbound` tRPC router: `sources.{list,create,rename,pause,resume,rotateSecret,delete}` and
  `receipts.list`; membership for reads, owner/admin (`WorkspaceService.assertAdmin`) for writes.
- Tests: route via `fetch`, router via `createCaller` (cross-tenant NOT_FOUND, member FORBIDDEN).

## 8. Review follow-ups

- Route: malformed ingest key → 404 before the body or the DB; 1 MB body limit → 413.
- Hard ceiling (`INBOUND_HARD_LIMIT`, 4× the daily limit, any outcome) → 429 with no writes,
  logged once per workspace per window.
- Logs carry ids, the error class and a driver code only; a secret that fails to open logs the
  source id.
- `beforeSeq` bounded to the bigint range (BAD_REQUEST otherwise).
- `publish_attempts` on receipts: the republish scan takes the fewest first and gives up after 5,
  or at once for a payload the catalog rejects.
- `last_received_at` throttled to once a minute and non-fatal.
- `assertAdmin` is one `getActiveMemberRole` lookup that implies membership.
- No unique constraint on `seq` (nothing needs it).

## 9. Docs

`docs/reference/inbound.md`, ADR 0019 and the ADR index, the events reference.

## Deferred

- Default notification rules per source kind (spec §7) need the notification rules of #117.
- The Sources tab of the notifications UI and the customer guides (#244).
