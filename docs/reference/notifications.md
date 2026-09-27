---
title: Notifications
description: The notification model (channels, rules, deliveries), how rules and filters match events, the delivery lifecycle of the notification.deliver job, and the Discord failure policy (rate limit buckets, channel disabling, sender pause, per-workspace fairness).
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [reference, notifications, discord, events, jobs]
related:
  - ./events.md
  - ./jobs.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
  - ../specs/2026-09-24-platform-foundations-design.md
code_refs:
  - packages/backend/src/domain/notification/NotificationService.ts
  - packages/backend/src/domain/notification/DeliveryService.ts
  - packages/backend/src/domain/notification/rules.ts
  - packages/backend/src/domain/notification/templates.ts
  - packages/backend/src/domain/notification/jobs.ts
  - packages/backend/src/domain/notification/subscribers.ts
  - packages/backend/src/domain/notification/constants.ts
  - packages/backend/src/domain/notification/senders/discord.ts
  - packages/backend/src/domain/notification/repos/delivery.repo.ts
  - packages/backend/src/domain/notification/repos/discord-rate-limit.repo.ts
  - packages/common/src/notification.ts
---

# Notifications

Mocco posts the events a workspace cares about to its Discord channels. The pipeline is the
platform one ([platform foundations](../specs/2026-09-24-platform-foundations-design.md) §12, with
Discord first per the [notification relay design](../superpowers/specs/2026-09-25-notification-relay-design.md)
§6–§8):

```
EventBus.publish ─▶ events.deliver ─▶ NotificationService.handle (fan-out)
                                         │ rules match → one delivery per channel, one job each
                                         ▼
                              notification.deliver ─▶ DeliveryService.deliver ─▶ DiscordApi.sendMessage
```

Notifications are workspace-level: there is no product to enable (they are not in `Products`),
and a channel belongs to a workspace, not a project.

## Model

| Table | What it holds |
|---|---|
| `mocco_notification_channels` | A destination: `kind` (`discord`), a label, `config` `{ guildId, channelId, channelName }`, `external_id` (the Discord channel id; unique per workspace and kind), `status` `active`/`disabled` with `disabled_reason`, and `secret_sealed` (reserved for a customer bot token; null means the Mocco bot). |
| `mocco_notification_rules` | Which events a channel gets: `event_type`, optional `source_id`, `filter`. Pinned to its channel's workspace by a composite FK; deleted with the channel. The same rule twice on one channel is one row (unique on channel, type, source, filter). |
| `mocco_notification_deliveries` | One event sent (or not) to one channel: `status` (`queued`, `sending`, `sent`, `failed`, `suppressed`), `attempts` (sends tried), `response_code`, `error`, `external_message_id`, `next_attempt_at`, `sending_at` (the claim), `sent_at`, the matching `rule_id` (indexed where not null, for the SET NULL on rule delete), and the rendered `message`. Unique on `(event_id, channel_id)`. |
| `mocco_discord_rate_limits` | Shared Discord pacing: `bucket` (`channel:<discord channel id>` or `global`) → `blocked_until`. Platform-scoped, since every workspace posts through the same bot. |

Retention: a delivery is deleted with its domain event (`event_id … ON DELETE CASCADE`), so
deliveries live 30 days, like events and (later) inbound receipts, and the activity trace ages out
as one piece. A deleted channel keeps its deliveries (`channel_id` becomes null); a deleted rule
leaves `rule_id` null.

## Rules and filters

`isRuleMatch(rule, event)` in `rules.ts` is pure:

- `event_type` is an exact catalog type (`gate.pending`) or a prefix wildcard (`gate.*`,
  `github.pull_request.*`), matched with the catalog's `isEventPatternMatch`.
- `source_id`, when set, must equal the event payload's `sourceId` (inbound events only; a
  governance event never matches a source-bound rule). The column has no FK yet: the inbound
  sources table lands with the ingest route.
- `filter` is a flat object; every key must equal the event's `payload.facts[key]`, compared
  strictly (`true` is not `"true"`). `{}` matches everything.

`explainNoMatch(rules, event)` runs the same checks and returns one sentence for the activity
trace, e.g. ``rule `vercel.deployment.succeeded` needs target = "production" (the event has "preview")``.

## Fan-out

The bus subscriptions live in `createEventBus` (`domain/events/subscriptions.ts`), registered by
`registerNotificationSubscribers`: `gate.*`, `run.*`, `sentry.*`, `vercel.*` and `github.*`, under the
permanent names in `NotificationSubscribers` (`notification.fan-out.<family>`). The inbound
families receive nothing until their types join the catalog (#243).

For each event, `NotificationService.handle`:

1. loads the workspace's **active** channels and its rules (the event's workspace only; a channel
   of another workspace is never a candidate);
2. picks, per channel, the first rule that matches (no match → no delivery);
3. renders the message once (`templates.ts`);
4. per target, in one transaction: inserts the delivery with `ON CONFLICT (event_id, channel_id)
   DO NOTHING` and, when inserted, enqueues `notification.deliver { deliveryId }` with
   `executor: tx`, `dedupeKey = deliveryId`, the workspace and `maxAttempts = 8`;
5. kicks each job after its transaction commits.

It is idempotent: the event bus may hand the same event over again (a repeated publish, a crash
before the ledger write), and the unique pair makes that a no-op.

## Templates

`renderEventMessage(event, { appOrigin })` returns a `NeutralMessage`:

- inbound events: the `payload.message` their adapter rendered at ingest, parsed again;
- `gate.pending` / `gate.resumed` / `gate.rejected` / `run.succeeded` / `run.failed`: built from the
  payload (repo, pipeline, short commit, trigger, gate; the requirements as "2 × deployer" on
  `gate.pending`; the resuming roles on `gate.resumed`; the reason on `gate.rejected`; the failed
  step and an http(s) logs link on `run.failed`). The link is `appOrigin + payload.linkPath`, where
  `appOrigin` comes from `SERVICE_DOMAIN` (`resolveBaseOrigin`).

## Delivery lifecycle

`queued` → `sending` (claimed by a run, while Discord is called) → `sent` | `failed`, or back to
`queued` to wait; `suppressed` when the channel was deleted. Settled rows (sent, failed,
suppressed) are never updated again: every write is conditional on the status it expects.
`DeliveryService.deliver(deliveryId, { isFinalAttempt, now })`:

1. no row (pruned with its event) or settled → return. A fresh `sending` claim (another run is
   calling Discord) → free `RetryAt` for when that claim would turn stale (2 min);
2. channel deleted → `suppressed` (`channel deleted`);
3. channel disabled → `failed` (`channel disabled: <reason>`);
4. the channel's Discord id is not a snowflake → `failed` (never sent to; see the sender pause below);
5. no Discord bot token on this deployment → free wait `+1h` (`discord not configured`, logged).
   A deployment cannot create Discord channels without the env, so this only happens when the
   token was removed;
6. a blocked `channel:<id>` or `global` bucket → free wait until `blocked_until`;
7. per-workspace fairness: 120 or more sends in the last 60 s → free wait until the oldest of them
   leaves the window, plus `random() × 60 s` of jitter so the waiting deliveries spread over the
   next window;
8. claim: one conditional `UPDATE … SET status = 'sending', sending_at = now, attempts + 1 WHERE
   status = 'queued' (or a sending claim older than 2 min) RETURNING`. Losing the claim to another
   run means that run sends;
9. `DiscordApi.sendMessage` with `nonce` = the delivery id as 22 base64url characters and
   `enforce_nonce: true`, then the result mapping below.

**Free waits** are `RetryAt(at, reason, { consumesAttempt: false })`: the runner always refunds
them and does not count them towards the five-in-a-row cap
([jobs](./jobs.md#retryat-retry-at-a-specific-time)), so waiting for capacity never makes a job
`dead`. They are bounded by age instead: a delivery still waiting 24 h after it was queued
(`DeliveryPolicy.maxQueuedMs`) is `failed` with `expired waiting for capacity (<reason>)`.

Every wait stores `error` and `next_attempt_at`. The job's final attempt is the runner's
`ctx.isFinalAttempt`; only a transient failure uses it (below).

### Discord failure policy

| Result | Delivery | Also |
|---|---|---|
| `sent` | `sent`, `external_message_id`, `sent_at` | an exhausted bucket (`X-RateLimit-Remaining: 0`) is blocked until its reset |
| `rate_limited` | queued, `response_code` 429, consuming `RetryAt(retry_at)` | the bucket (`channel:<id>`, or `global` for a global limit or a Cloudflare ban) is blocked until then. A 429 counts as an invalid request at Discord, so it stays a consuming RetryAt (five in a row are refunded) |
| `permanent` + `disableChannel` (403/404 with 10003, 10004, 50001, 50013) | `failed` with Discord's reason | the channel is `disabled` with that reason; later deliveries to it fail at step 3 |
| `permanent` + `disableSender` (401, uncoded 403/404, Cloudflare 40333) | queued, free wait `+1h` | the `global` bucket is blocked for 1 h and the pause is logged as an error. The problem is Mocco's configuration, not the tenant's, so no channel is disabled. This relies on channel ids being validated snowflakes (step 4 and channel binding): a malformed id would give an uncoded 404 and pause everyone |
| other `permanent` (e.g. 50035) | `failed` | none |
| `transient` (5xx, timeout, network) | queued with the reason; thrown so the job backs off (about 2 h over 8 attempts) | `failed` when `ctx.isFinalAttempt` |

Reasons come from the Discord client already redacted (never the bot token).

### No double posts

- Two overlapping runs of one job (a reclaimed lock) race for the claim in step 8; only one gets
  the row, the other waits.
- A run that dies after Discord accepted the post leaves a `sending` claim. After 2 min another run
  may resend it; the nonce makes Discord return the message it already created instead of posting
  again. Discord only remembers nonces for a few minutes, so a resend much later than that could
  still post twice (at-least-once, in practice once).

### Reconcile

`notification.reconcile` runs every 5 minutes as a platform schedule. It fails (`the delivery job
ended before the delivery settled`) up to 500 `queued` or `sending` deliveries that have no live
`notification.deliver` job (queued or running, matched by the job's dedupe key = the delivery id):
their job died of consuming failures (429s, transient errors) or was pruned. A schedule was chosen
over a runner `onDead` hook because it also catches jobs lost for any other reason, and it keeps
the job runner free of domain callbacks.

### Prune

`notification.prune` runs daily and deletes `mocco_discord_rate_limits` rows whose
`blocked_until` has passed.

`timestamp` columns here, as everywhere in the schema, are `timestamp without time zone` written
by the app in UTC (the repo convention, [DB conventions](./db-conventions.md)), not `timestamptz`.

## Env

| Var | Meaning |
|---|---|
| `DISCORD_BOT_TOKEN` | The Mocco bot's token. Without it the runner's Discord client is undefined and deliveries wait (step 4). |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The bot install OAuth pair (the install routes land in the next slice). |

All are optional; a deployment without them boots.

## Testing

`DeliveryService.test.ts` runs the real `DiscordApi` over `createFakeDiscordFetch` (scripted
replies) on pglite and covers every result mapping, the buckets, fairness and jitter, the age
bound, claims, the nonce, reconcile and prune. `delivery-capacity.test.ts` runs the review repros
through the real job runner: a channel bucket blocked 30 s at a time for 20 rounds, and 1500
deliveries at 120/min (all sent, one attempt each, never over 120 in a window).
`NotificationService.test.ts` publishes through the real bus (`createEventBus`) and covers fan-out,
filters, redelivery and tenant isolation. `runtime/jobs.test.ts` runs a gate event through the tick
to a sent Discord message. Seed helpers are in `domain/notification/testing/seed.ts`.
