---
title: Stage0 canary and external heartbeat implementation plan
description: Plan for #245 — the ops domain with Stage0Service, the ops.stage0-canary schedule, a signed synthetic GitHub webhook sent over HTTP to a canary source, canary-marked deliveries, a sent-listener port on DeliveryService that deletes the canary message and pings OPS_HEARTBEAT_URL, and the tests for the heartbeat invariant.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, ops, notifications, inbound, monitoring]
implements: ../../adr/0020-moccos-own-alerts-go-through-mocco-guarded-by-an-external-heartbeat.md
related:
  - ../specs/2026-09-25-notification-relay-design.md
  - ./2026-09-25-inbound-service.md
  - ../../reference/ops-stage0.md
---

# Stage0 canary and external heartbeat implementation plan

Issue #245, stacked on the inbound service (#258), which sits on the Discord install (#259) and the
notification core (#260). Design: notification relay spec §11 and §14 (ADR 0020).

## 1. Decisions

- **The canary payload.** A GitHub `workflow_run` with `action: completed`, `conclusion: success`,
  workflow `mocco-stage0-canary`, repository `mocco/stage0`, sender `mocco-stage0`, and the canary
  id as `head_branch`. It maps to `github.workflow_run.succeeded`, a real catalog type, so it takes
  the whole path to a Discord delivery; a `ping` would be ignored at ingest. No new event type.
- **The canary id** `stage0-<ISO minute>` is the `X-GitHub-Delivery` (receipt dedupe for a retry in
  the same minute) and the `branch` fact (matches a delivery back to its canary record).
- **Identification by source.** A canary is a `github.workflow_run.succeeded` event from
  `OPS_CANARY_SOURCE_ID` with the canary workflow and a `stage0-` branch. Content alone never
  counts, so another workspace cannot spoof the heartbeat.
- **The ping lives in the delivery path.** `DeliveryService` gets an optional `onSent` port called
  after a successful settle to `sent`; `runtime/jobs.ts` binds it to `Stage0Service.onDelivered`.
  No import from notification to ops, and nothing else can ping.
- **Record, don't throw.** A refused or failed canary is recorded in `mocco_ops_canaries` and
  logged; the job succeeds. Retrying would only send more canaries, and the silent heartbeat is the
  alert.

## 2. Env (`infra/config/env.ts`)

`OPS_CANARY_SOURCE_ID` (uuid) and `OPS_HEARTBEAT_URL` (http(s) URL), both optional.
`domain/ops/config.ts` `stage0ConfigFromEnv` returns undefined unless both are set, and carries
`SERVICE_DOMAIN`.

## 3. Migration

- `mocco_notification_deliveries.canary boolean NOT NULL DEFAULT false`.
- `mocco_ops_canaries`: `canary_id` (unique), `source_id`, `sent_at`, `ingest_status`, `error`,
  `delivered_at`, `heartbeat_at`, `heartbeat_status`, timestamps; index on `sent_at` for the prune.

## 4. `domain/ops/`

- `constants.ts`: `OpsJobKinds`, `Stage0Policy` (300 s, 10 s ingest timeout, 5 s heartbeat timeout,
  7-day retention), `Stage0Canary`, `CanaryOutcomes`, `CanaryReasons`.
- `canary.ts` (pure): `canaryIdAt`, `buildCanaryRequest` (HMAC-SHA256 over the exact bytes),
  `canaryIngestUrl` (the SSRF guard: exactly `SERVICE_DOMAIN` and the ingest path),
  `stage0CanaryMatcher`.
- `repos/ops-canary.repo.ts`: `record` (upsert by canary id), `markDeliveredByEvent` (canary id from
  the event's `branch` fact), `recordHeartbeat`, `findRecent`, `pruneBefore`.
- `Stage0Service`: `sendCanary(now)` loads the source (`InboundSourceRepo.findById`, new), checks
  kind and status, builds the URL, opens the secret, POSTs with `redirect: 'manual'` and records the
  outcome; `onDelivered(sent)` marks the record delivered, deletes the message
  (`DiscordApi.deleteMessage`) and pings the heartbeat (`GET`, 5 s, never throws); `pruneCanaries`.
- `jobs.ts`: `ops.stage0-canary` handler (always registered) and `opsSchedules(isEnabled)`.

## 5. Composition

- `NotificationService` takes an optional `isCanary` matcher and sets `canary` on new deliveries;
  `createEventBus` passes it through the notification subscribers. Both roots
  (`events/instance.ts`, `runtime/jobs.ts`) bind it from the env.
- `runtime/jobs.ts`: `JobRunnerRuntimeDeps` gains `box` (the lazy SecretBox in production) and
  `stage0?: { config, fetch }`; builds `Stage0Service`, wires `onSent`, adds the ops handlers and
  the conditional schedule.
- `@mocco/common/notification`: `canary` on the delivery DTO.

## 6. Tests (pglite, fakes, no `vi.mock`)

- `domain/ops/canary.test.ts`: the request verifies and parses with the real GitHub adapter; the URL
  guard (userinfo, path, query, fragment, port, scheme, missing domain, bad keys); the matcher
  (other source, type, workflow, branch); the env switch.
- `transport/ext/stage0.test.ts`: the runner's canary through `app.fetch` of the real ingest route
  to a fake Discord: sent → delete + one ping; a failed delete still pings; no ping for 503, 500,
  unreachable, a queue that does not run (then one ping once it drains), a paused sender, a
  disabled channel, a paused or missing source, SSRF refusals, a redirect, a look-alike run from
  another source; no schedule without the env. An `afterEach` asserts the invariant in every test:
  pings equal sent canary deliveries.

## 7. Docs

`reference/ops-stage0.md` (setup, table, failure table), ADR 0020 and its index rows,
`reference/env.md`, `reference/notifications.md` (canary column, the sent-listener),
`reference/jobs.md` (conditional platform schedules), the wiki log.

## 8. Deferred

- The activity trace UI hiding or labelling canary deliveries (the DTO carries `canary`).
- A read surface for `mocco_ops_canaries` (SQL only for now).
- The canary's delete does not feed Discord rate limit buckets back to the pacing table.
- Canaries for senders other than Discord, when they exist.
