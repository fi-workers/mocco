---
title: Stage0 canary and external heartbeat
description: How Mocco watches its own notification path — the ops.stage0-canary schedule sends a signed synthetic GitHub webhook over HTTP to a canary source, its Discord delivery deletes the message and pings an external dead-man switch — how to set it up, and what each failure looks like.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [reference, ops, notifications, inbound, jobs, monitoring]
related:
  - ../adr/0020-moccos-own-alerts-go-through-mocco-guarded-by-an-external-heartbeat.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
  - ./inbound.md
  - ./notifications.md
  - ./jobs.md
  - ./env.md
code_refs:
  - packages/backend/src/domain/ops/Stage0Service.ts
  - packages/backend/src/domain/ops/canary.ts
  - packages/backend/src/domain/ops/config.ts
  - packages/backend/src/domain/ops/constants.ts
  - packages/backend/src/domain/ops/jobs.ts
  - packages/backend/src/domain/ops/repos/ops-canary.repo.ts
  - packages/backend/src/domain/notification/DeliveryService.ts
  - packages/backend/src/runtime/jobs.ts
  - packages/backend/src/transport/ext/stage0.test.ts
---

# Stage0 canary and external heartbeat

Mocco's own Sentry, Vercel and GitHub alerts are meant to go through Mocco. An outage of Mocco
would then also silence the alert about it. Stage0 closes that gap: every 5 minutes Mocco sends
itself a canary through the whole notification path, and only a canary that actually reached
Discord pings an external dead-man switch. When the pings stop, that service alerts the team
through its own Discord integration, outside Mocco. The decision is
[ADR 0020](../adr/0020-moccos-own-alerts-go-through-mocco-guarded-by-an-external-heartbeat.md);
the design is §11 of the [notification relay spec](../superpowers/specs/2026-09-25-notification-relay-design.md).

## The path a canary takes

```
tick ─▶ ops.stage0-canary ─▶ POST https://<SERVICE_DOMAIN>/api/ext/inbound/<canary ingest key>   (real HTTP)
                               │ InboundService: verify signature → receipt → publish
                               ▼
        events.deliver ─▶ NotificationService (rule on the canary channel; delivery marked canary)
                               ▼
        notification.deliver ─▶ DeliveryService ─▶ Discord POST /channels/{id}/messages
                               │ sent
                               ▼
        Stage0Service.onDelivered ─▶ Discord DELETE the message ─▶ GET OPS_HEARTBEAT_URL
```

- **The canary is a real mapped GitHub event.** A `ping` is ignored at ingest and would never reach
  Discord, so the canary is a `workflow_run` delivery with `action: completed` and
  `conclusion: success`, which the GitHub adapter maps to `github.workflow_run.succeeded`. It is
  marked in every field a person sees: workflow `mocco-stage0-canary`, repository `mocco/stage0`,
  sender `mocco-stage0`, and the canary id as the run's branch.
- **The canary id** is `stage0-<ISO minute>` (`stage0-2026-09-25T10:05Z`). It is the
  `X-GitHub-Delivery` header, so the receipt dedupes a job retried within the same minute, and
  the `branch` fact, so the delivery can be matched back to its canary record.
- **Signed like GitHub signs**: `X-Hub-Signature-256: sha256=<HMAC-SHA256 hex of the body>` with the
  canary source's own secret, which the job opens with SecretBox. The request goes through the real
  public route, so the route, the function, the DB and the queue are all exercised.
- **SSRF guard.** The canary is only POSTed to `SERVICE_DOMAIN`. The URL is built from it and must
  come out with exactly that host and the ingest path; a `SERVICE_DOMAIN` that is not a bare
  authority (`host@evil`, a path, `:443`) or a malformed ingest key refuses the canary, and
  redirects are not followed. Without `SERVICE_DOMAIN` the canary is refused (never sent to the
  Vercel URL fallback).
- **Which deliveries are canaries.** At fan-out, a `github.workflow_run.succeeded` event whose
  `sourceId` is `OPS_CANARY_SOURCE_ID`, whose `workflow` is `mocco-stage0-canary` and whose
  `branch` starts with `stage0-` makes a delivery with `canary = true`
  (`mocco_notification_deliveries.canary`, `canary` on the delivery DTO). The source id is what
  makes it trustworthy: only Mocco signs for that source, so a run with the same name from any
  other source is an ordinary delivery that pings nothing.
- **The heartbeat invariant.** `OPS_HEARTBEAT_URL` is pinged in exactly one place: the
  `DeliveryService` sent-listener, after a canary delivery was settled `sent` by this run. The
  listener is a port (`DeliverySentListener`) that `runtime/jobs.ts` binds to
  `Stage0Service.onDelivered`, so the notification domain never imports ops. A failing listener is
  logged and never retries or changes the delivery.
- **Cleanup.** After the send, the canary deletes its own message (`DELETE
  /channels/{id}/messages/{id}`; a bot may always delete its own messages). A failed delete is
  logged and the heartbeat is still pinged: the send is what the check proves. The ping is a
  `GET` with a 5 s timeout that never throws; the URL is never logged, since a ping URL is a
  credential for its check.

## Setting it up

Prerequisites on the deployment: `SERVICE_DOMAIN`, `SECRETS_ENCRYPTION_KEYS`,
`DISCORD_BOT_TOKEN` (and the install pair), and the tick (`CRON_SECRET`). See
[env](./env.md).

1. **A private Discord channel.** In the team's server, create a text channel such as
   `#mocco-canary`, visible only to the Mocco bot (View Channel, Send Messages, Embed Links, Read
   Message History) and whoever wants to watch it. Messages disappear right after they post, so
   it stays empty while things work.
2. **Bind it in Mocco.** In the workspace that runs Mocco's own alerts, connect Discord if needed
   and add the channel (`notification.createChannel`). The test message must succeed.
3. **The canary source.** Create an inbound source of kind `github` named `stage0 canary`
   (`inbound.sources.create`). Mocco generates its secret; you do not need it, and its ingest URL
   must not be added to any GitHub repository. Note the source's `id`.
4. **The rule.** On the canary channel, add one rule: event type `github.workflow_run.succeeded`,
   `sourceId` = the canary source (`notification.addRule`). Do not apply the `github` preset to
   this channel, and do not route the canary source anywhere else.
5. **The external check.** On healthchecks.io (or any dead-man switch with a ping URL), create a
   check with a period of 5 minutes and a grace time of 15 minutes, and give it a Discord
   integration that posts straight to a team channel (healthchecks.io's own Discord integration,
   not a Mocco channel). Copy its ping URL (`https://hc-ping.com/<uuid>`).
6. **The env vars**, then redeploy:

   | Var | Value |
   |---|---|
   | `OPS_CANARY_SOURCE_ID` | the canary source's id (a uuid) |
   | `OPS_HEARTBEAT_URL` | the check's ping URL (http or https) |

   Stage0 is off unless both are set: no schedule is registered and no canary is sent. On the
   next tick after the deploy, `ops.stage0-canary` appears in `mocco_job_schedules` and runs every
   300 s.
7. **Check it.** Within a few minutes the check turns green, and `mocco_ops_canaries` has rows with
   `ingest_status = 202`, `delivered_at` and `heartbeat_status = 200`.

Turning it off: unset either var. The schedule row stays; its job is registered even without the
env and does nothing, so no unknown-kind jobs pile up. Disable the row by hand to stop even that.

## `mocco_ops_canaries`

One row per canary, platform-scoped, pruned after 7 days by the canary job itself:

| Column | Meaning |
|---|---|
| `canary_id` | `stage0-<ISO minute>` (unique; a retry in the same minute overwrites) |
| `source_id` | the canary source at the time |
| `sent_at` | when the job ran |
| `ingest_status` | what the ingest route answered; null when nothing was sent or it never answered |
| `error` | why the canary was refused or failed before Discord |
| `delivered_at` | when its Discord delivery was sent |
| `heartbeat_at`, `heartbeat_status` | the ping, and what the check answered (null: no answer) |

## What each failure looks like

The external check alerts after the period plus the grace time without a ping (about 20 minutes
with the values above; lower the grace for a faster alert). Where to look first:

| What broke | `mocco_ops_canaries` | Elsewhere |
|---|---|---|
| The tick is not called (cron, `CRON_SECRET`), or the DB is down | no new rows | tick route logs; the job table |
| The ingest route or its function is down, or the DB is down for it | `ingest_status` 5xx, or `error` "the ingest route did not answer (…)" | no receipt on the canary source |
| `SERVICE_DOMAIN` missing or not a bare host | `error` "SERVICE_DOMAIN is not set" / "the ingest URL is not on SERVICE_DOMAIN" | `[stage0]` error log |
| The canary source was paused, deleted or is not GitHub | `error` names it | the source list |
| The source secret does not open (`SECRETS_ENCRYPTION_KEYS` missing or its key removed) | `error` "the canary source secret does not open" | the ingest route answers 503 too |
| The queue is stuck (`events.deliver` / `notification.deliver` not running) | `ingest_status = 202`, `delivered_at` null | receipt `published`, delivery missing or `queued` |
| The Discord sender is paused (401 or a Cloudflare block) | `delivered_at` null | delivery `queued` with `sender paused: …`; `DISCORD SENDER PAUSED` error log |
| No `DISCORD_BOT_TOKEN` | `delivered_at` null | delivery `queued` with `discord not configured` |
| The bot lost the canary channel | `delivered_at` null | delivery `failed`, channel `disabled` with the reason; re-enable it |
| The heartbeat service is down | `heartbeat_status` null | a false alarm from the check, if it recovers late |

A canary whose delete failed leaves one message in the private channel and a `[stage0]` warning;
the heartbeat is unaffected.

## Side effects on the workspace

- The canary source collects one receipt every 5 minutes (288 a day, well under the 5,000 daily
  quota), kept 30 days like any receipt.
- Canary deliveries appear in the workspace's deliveries with `canary: true`, so the activity
  trace can hide or label them. They count towards the workspace's 120 sends per minute.

## Testing

`transport/ext/stage0.test.ts` runs the whole path on pglite: the runner's canary job POSTs through
a `fetch` that is the real ingest route's `app.fetch` (and records heartbeat pings), the delivery
goes to a scripted fake Discord, and an `afterEach` checks the invariant for every test: pings equal
the number of sent canary deliveries. The failure tests cover a 503, a 500 and an unreachable
ingest host, a queue that does not run, a paused sender (401), a disabled channel (403 50001), a
paused and a missing source, both SSRF refusals, an unfollowed redirect, a look-alike run from
another source, and stage0 off without the env. `domain/ops/canary.test.ts` checks the signature
and mapping against the real GitHub adapter, the URL guard and the matcher.
