---
title: Inbound webhook sources
description: How Sentry, Vercel and GitHub deliver to a workspace through per-source signed ingest URLs — where each vendor's secret comes from, the ingest flow and its status codes, receipt outcomes, the daily quota, republishing, retention, and the inbound tRPC router.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, inbound, webhooks, notifications, events]
related:
  - ../adr/0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
  - ./events.md
  - ./jobs.md
code_refs:
  - packages/backend/src/domain/inbound/InboundService.ts
  - packages/backend/src/domain/inbound/SourceService.ts
  - packages/backend/src/domain/inbound/constants.ts
  - packages/backend/src/domain/inbound/jobs.ts
  - packages/backend/src/domain/inbound/sources/adapters.ts
  - packages/backend/src/domain/inbound/repos/inbound-source.repo.ts
  - packages/backend/src/domain/inbound/repos/inbound-receipt.repo.ts
  - packages/backend/src/transport/ext/inbound.ts
  - packages/backend/src/transport/trpc/routers/inbound.ts
  - packages/common/src/inbound.ts
---

# Inbound webhook sources

A workspace connects a Sentry, Vercel or GitHub account as an **inbound source**. Each source has
its own ingest URL and signing secret. Every delivery is verified, recorded as a **receipt**, and,
when the adapter maps it, published as a [domain event](./events.md) (`sentry.issue.created`,
`github.push`, …) that notification rules route to channels. The decision is
[ADR 0019](../adr/0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md);
the design is §5 of the [notification relay spec](../superpowers/specs/2026-09-25-notification-relay-design.md).

## Ingest URL

```
POST https://<SERVICE_DOMAIN>/api/ext/inbound/<ingestKey>
```

The ingest key is 32 random bytes, base64url, generated when the source is created. It names the
source, and through it the workspace; nothing in the payload is used to find the tenant. It is an
identifier, not a credential: every request must also carry a valid signature. The origin comes from
`SERVICE_DOMAIN` (falling back to the deployment's Vercel URL), like the executor callback URL.

The route answers `503 inbound webhooks are not configured` when `SECRETS_ENCRYPTION_KEYS` is not
set, since no secret can be opened.

## Secrets per vendor

| Kind | Where the customer configures the webhook | The secret comes from | Signature | Delivery id |
|---|---|---|---|---|
| `sentry` | Settings → Developer Settings → Custom Integration (internal), webhook URL + the "issue" resource | Sentry shows the integration's Client Secret; the customer pastes it into Mocco | `Sentry-Hook-Signature`, HMAC-SHA256 hex | `Request-ID` header |
| `vercel` | Team Settings → Webhooks (Pro/Enterprise) | Vercel shows the webhook secret once; the customer pastes it | `x-vercel-signature`, HMAC-SHA1 hex | payload `id` |
| `github` | Repo or org Settings → Webhooks, content type JSON | Mocco generates it (32 random bytes, hex) and shows it once; the customer pastes it into GitHub | `X-Hub-Signature-256`, `sha256=` + HMAC-SHA256 hex | `X-GitHub-Delivery` |

- A source cannot exist without a secret, and there is no unverified mode. A pasted secret is
  trimmed and must be non-empty; a GitHub source refuses a pasted one.
- The secret is sealed with SecretBox (`secret_sealed`, AAD `mocco_inbound_sources:<id>`) and is
  never returned. Sources on the wire carry `hasSecret: true` instead.
- `create` and `rotateSecret` of a GitHub source return the new secret once, as `generatedSecret`
  (`null` for Sentry and Vercel). Rotation keeps the ingest URL.

## Ingest flow

`InboundService.ingest({ ingestKey, body, headers })`. The route reads the body with
`arrayBuffer()`: signatures are checked on the exact bytes (a body with a UTF-8 BOM, or invalid
UTF-8, must verify as sent).

| Step | Result |
|---|---|
| 1. Look up the source by ingest key | Unknown or paused → `404 not found`, nothing written |
| 2. Open the secret, verify the signature (constant time) | Invalid or missing → `401 invalid signature`, nothing written |
| 3. Decode the body (strict UTF-8, BOM stripped), take the delivery id | Missing, blank or over 256 characters → `400 missing delivery id` |
| 4. Parse with the adapter | An event (type, facts, message) or an ignored reason; invalid UTF-8 is ignored with `body is not valid UTF-8` |
| 5. Insert the receipt, one statement, `ON CONFLICT (source_id, external_id) DO NOTHING` | A redelivery → `202`, no further work; ignored → `202` |
| 6. Quota: published receipts of the workspace in the last 24 h | At `INBOUND_DAILY_LIMIT` (5,000) or more → the receipt becomes `over_quota` → `202` |
| 7. Publish the event with `dedupeKey = inbound:<receiptId>`, mark the receipt `published` with `domain_event_id` | `202 accepted` |

Every verified delivery with a delivery id also updates the source's `last_received_at`.
`202` means **recorded**: delivery to Discord never runs on the request path. If the publish in
step 7 fails, the receipt stays `pending` and the request is still `202`. Anything unexpected (the
DB, a secret that no longer opens) is a bare `500 Internal server error`; only the error's class
name is logged.

The event's subject is `inbound_receipt` / receipt id, its `occurredAt` is the receipt's
`received_at`, and its payload is `{ sourceId, facts, message }` (`inboundEventPayloadSchema` in
`@mocco/common/events`), the same for all sixteen inbound types.

## Receipts and outcomes

`mocco_inbound_receipts` is the "why didn't it arrive?" trace.

| Outcome | Meaning | `reason` |
|---|---|---|
| `pending` | Recorded, event not published yet (seconds, or a crash) | null |
| `published` | The event exists; `domain_event_id` points to it (null once the event is pruned) | null |
| `ignored` | The adapter produced no event (`sentry action "resolved" is not mapped`, `ping`, malformed JSON, invalid UTF-8) | the adapter's reason |
| `over_quota` | Dropped by the daily quota | `workspace is over the daily limit of 5000 events` |

`source_event` holds the vendor's own name for the delivery (`issue.created`,
`deployment.succeeded`, `pull_request.opened`, `push`), when there is one. `normalized` holds the
event payload, so a stuck `pending` receipt can be republished.

Sources do not retry reliably (Sentry never, GitHub only by hand), so an over-quota delivery is
still answered `202`: the trace shows the drop.

## Jobs

| Kind | Schedule | Does |
|---|---|---|
| `inbound.republish-stale` | every 60 s (platform schedule) | Publishes `pending` receipts older than 60 s, up to 1,000 per run, with the same dedupe key, and marks them `published`. The quota is not checked again. A stored payload that no longer parses is marked `ignored`. |
| `inbound.prune` | daily (platform schedule) | Deletes receipts whose `received_at` is older than 30 days, 1,000 per statement, until none are left or the run's lock deadline passes. |

Because the dedupe key is the receipt id, a republish that races a slow original returns the same
event instead of publishing a second one.

## tRPC: `inbound`

Reads need workspace membership; writes need an owner or admin (`FORBIDDEN` for a plain member). A
non-member gets `NOT_FOUND` on every procedure, and a source of another workspace is `NOT_FOUND`.
The router is `PRECONDITION_FAILED` when `SECRETS_ENCRYPTION_KEYS` is not set.

| Procedure | Input | Output |
|---|---|---|
| `inbound.sources.list` | `workspaceId` | `{ sources }` |
| `inbound.sources.create` | `workspaceId, kind, name, secret?` | `{ source, generatedSecret }` |
| `inbound.sources.rename` | `workspaceId, sourceId, name` | `{ source }` |
| `inbound.sources.pause` / `.resume` | `workspaceId, sourceId` | `{ source }` |
| `inbound.sources.rotateSecret` | `workspaceId, sourceId, secret?` | `{ source, generatedSecret }` |
| `inbound.sources.delete` | `workspaceId, sourceId` | `{ ok: true }` (receipts cascade) |
| `inbound.receipts.list` | `workspaceId, sourceId?, outcome?, beforeSeq?, limit? (1–100, default 50)` | `{ receipts, nextCursor }`, newest first |

`seq` and the `beforeSeq` / `nextCursor` cursor are digit strings (a bigserial), like the audit log.

## Tables

- `mocco_inbound_sources`: `id` (generated by `SourceService` so the AAD is known before the
  insert), `workspace_id` (cascade), `kind`, `name`, `ingest_key` (unique), `secret_sealed`
  (NOT NULL), `status` (`active` / `paused`), `last_received_at`, timestamps.
- `mocco_inbound_receipts`: `seq` (bigserial), `workspace_id` (cascade), `source_id` (composite FK
  to the source and its workspace, cascade), `external_id`, `source_event`, `outcome`, `reason`,
  `event_type`, `domain_event_id` (→ `mocco_domain_events`, `ON DELETE SET NULL`), `normalized`,
  `received_at`. `UNIQUE (source_id, external_id)`; indexes for the trace (`workspace_id, seq
  DESC`, `source_id, seq DESC`), the quota (`workspace_id, received_at` where published), the
  republish scan (`received_at` where pending) and the prune (`received_at`).

## Testing

`domain/inbound/testing/harness.ts` builds the real services over pglite with a SecretBox over a
random key and the real event bus, and `signedDelivery(kind, secret)` builds a signed delivery per
vendor from the adapter fixtures.
