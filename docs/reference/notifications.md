---
title: Notifications
description: The notification model (channels, rules, deliveries, Discord guilds), the Discord bot install and channel setup, the notification tRPC router and its role checks, how rules and presets match events, the delivery lifecycle of the notification.deliver job, and the Discord failure policy.
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
  - packages/backend/src/domain/notification/ChannelService.ts
  - packages/backend/src/domain/notification/DiscordInstallService.ts
  - packages/backend/src/domain/notification/instance.ts
  - packages/backend/src/transport/ext/discord.ts
  - packages/backend/src/transport/trpc/routers/notification.ts
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
| `mocco_notification_deliveries` | One event sent (or not) to one channel: `status`, `attempts`, `response_code`, `error`, `external_message_id`, `next_attempt_at`, `sent_at`, the matching `rule_id`, and the rendered `message`. Unique on `(event_id, channel_id)`. |
| `mocco_discord_guilds` | A Discord server the bot was installed into for a workspace: Discord's `guild_id` (from the OAuth token response), `guild_name`, `installed_by_user_id`. Unique per workspace and guild. |
| `mocco_discord_connect_states` | The install handshake: a single-use `state` bound to user and workspace, 10-minute expiry, `consumed_at` (same shape as `mocco_github_connect_states`). |
| `mocco_discord_rate_limits` | Shared Discord pacing: `bucket` (`channel:<discord channel id>` or `global`) → `blocked_until`. Platform-scoped, since every workspace posts through the same bot. |

Retention: a delivery is deleted with its domain event (`event_id … ON DELETE CASCADE`), so
deliveries live 30 days, like events and (later) inbound receipts, and the activity trace ages out
as one piece. A deleted channel keeps its deliveries (`channel_id` becomes null); a deleted rule
leaves `rule_id` null.

## Connecting Discord

1. `GET /api/ext/discord/install?workspaceId=<id>` (Hono, `transport/ext/discord.ts`). A signed-out
   user is sent to sign in; a non-member gets `404`; a member gets a state
   (`DiscordInstallService.startInstall`) and a redirect to Discord's authorize URL (`scope=bot
   identify`, View Channel + Send Messages + Embed Links + Read Message History).
2. `GET /api/ext/discord/callback?code&state` (`completeInstall`): the state is consumed atomically
   for the signed-in user (unknown, consumed, expired or another user's → `/workspaces?connect_error=1`),
   the code is exchanged through the `DiscordOAuth` port, and the guild **from the token response**
   is upserted (the `guild_id` query parameter is never read). Success lands on
   `/workspaces/<id>/notifications?tab=channels`; a failed exchange on the same page with
   `&connect_error=1`. A cancelled install (no `code`) → `/workspaces?connect_error=1`.
3. Both routes answer `503` unless `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and
   `DISCORD_BOT_TOKEN` are all set (an install without a bot token could bind guilds Mocco can never
   post to). The redirect URI is `<app origin>/api/ext/discord/callback`.

### Channels (`ChannelService`)

- `listGuildChannels` asks Discord for the guild's text and announcement channels with the bot token.
- `createChannel` binds a channel **only if the bot lists it in a guild installed for this
  workspace**. The bot is shared by every tenant, so a bare channel id from the client would let
  one workspace post into another's server. The channel is stored, then a test message is posted and
  its result returned (`{ sent, reason, channelDisabled }`): a permission error is shown right away,
  and a channel the bot cannot reach is stored `disabled` with the reason. A blocked bucket skips the
  test; a sender-level rejection pauses the sender as in the delivery path.
- `reenableChannel` sets a disabled channel `active` again (after the customer fixed access);
  `deleteChannel` removes it and its rules, keeping its deliveries.
- `addRule` accepts an exact type Mocco publishes (catalog or inbound) or any `prefix.*`; a duplicate
  is `CONFLICT`. `applyDefaultRules(channelId, preset, sourceId?)` inserts a preset and skips rules
  the channel already has.

### Presets

`rulePresetRules` in `@mocco/common/notification` (relay design §7):

| Preset | Rules |
|---|---|
| `mocco` | `gate.pending`, `gate.resumed`, `gate.rejected`, `run.failed` (never source-bound) |
| `sentry` | `sentry.issue.created` |
| `vercel` | `vercel.deployment.succeeded` `{ target: production }`, `vercel.deployment.error`, `vercel.deployment.canceled` |
| `github` | `github.push` `{ hasCommits: true }`, `github.pull_request.opened` / `.reopened` / `.merged` / `.closed`, `github.issues.opened` / `.reopened` / `.closed`, `github.release.published`, `github.workflow_run.failed` |

### tRPC `notification` router

Reads require membership of `workspaceId` (a non-member gets `NOT_FOUND`); writes also require an
owner or admin (`WorkspaceService.assertAdmin`, which splits the vendor's comma-joined role set; a
plain member gets `FORBIDDEN`). Every id in the input is looked up inside that workspace, so another
workspace's guild, channel or rule is `NOT_FOUND`. Outputs never carry `secret_sealed`,
`external_id`, workspace ids or the installing user.

| Procedure | Kind | Input | Output |
|---|---|---|---|
| `guilds` | query, member | `workspaceId` | `{ guilds: { id, guildId, guildName, createdAt }[] }` |
| `guildChannels` | query, member | `workspaceId, guildId` | `{ channels: { id, name, type }[] }` |
| `channels` | query, member | `workspaceId` | `{ channels: NotificationChannelDto[] }` |
| `createChannel` | mutation, admin | `workspaceId, guildId, channelId, name?` | `{ channel, test: { sent, reason, channelDisabled } }` |
| `deleteChannel` | mutation, admin | `workspaceId, channelId` | none |
| `reenableChannel` | mutation, admin | `workspaceId, channelId` | `{ channel }` |
| `rules` | query, member | `workspaceId, channelId` | `{ rules: NotificationRuleDto[] }` |
| `addRule` | mutation, admin | `workspaceId, channelId, eventType, sourceId?, filter?` | `{ rule }` |
| `removeRule` | mutation, admin | `workspaceId, ruleId` | none |
| `applyDefaultRules` | mutation, admin | `workspaceId, channelId, preset, sourceId?` | `{ rules }` (the ones added) |
| `deliveries` | query, member | `workspaceId, channelId?, status?, limit? (≤ 100, default 50)` | `{ deliveries: NotificationDeliveryDto[] }`, newest first |

Errors: not found → `NOT_FOUND`; duplicate channel or rule → `CONFLICT`; unknown event type,
Discord refusing a request, or Discord not configured → `BAD_REQUEST`.

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

`queued` → `sent` | `failed` | `suppressed`. Settled rows are never updated again (every write is
guarded by `status = 'queued'`), so a second or overlapping run of the job is a no-op once the
first settled it. `DeliveryService.deliver(deliveryId, { attempt, now })`:

1. no row (pruned with its event) or not `queued` → return;
2. channel deleted → `suppressed` (`channel deleted`);
3. channel disabled → `failed` (`channel disabled: <reason>`);
4. no Discord bot token on this deployment → stay queued, `RetryAt(+1h)` (`discord not configured`,
   logged). A deployment cannot create Discord channels without the env, so this only happens when
   the token was removed; waiting gives an operator time to restore it;
5. a blocked `channel:<id>` or `global` bucket → `RetryAt(blocked_until)`;
6. per-workspace fairness: 120 or more sends in the last 60 s → `RetryAt` when the oldest of them
   leaves the window (at least 1 s);
7. `attempts + 1`, then `DiscordApi.sendMessage` and the result mapping below.

Every wait stores `error` and `next_attempt_at`. On the job's last attempt (`attempt >= 8`) a wait
or a transient failure marks the delivery `failed` with the reason instead, so a delivery never
stays `queued` behind a dead job.

### Discord failure policy

| Result | Delivery | Also |
|---|---|---|
| `sent` | `sent`, `external_message_id`, `sent_at` | an exhausted bucket (`X-RateLimit-Remaining: 0`) is blocked until its reset |
| `rate_limited` | queued, `response_code` 429, `RetryAt(retry_at)` | the bucket (`channel:<id>`, or `global` for a global limit or a Cloudflare ban) is blocked until then |
| `permanent` + `disableChannel` (403/404 with 10003, 10004, 50001, 50013) | `failed` with Discord's reason | the channel is `disabled` with that reason; later deliveries to it fail at step 3 |
| `permanent` + `disableSender` (401, uncoded 403/404, Cloudflare 40333) | queued, `RetryAt(+1h)` | the `global` bucket is blocked for 1 h and the pause is logged as an error. The problem is Mocco's configuration, not the tenant's, so no channel is disabled |
| other `permanent` (e.g. 50035) | `failed` | none |
| `transient` (5xx, timeout, network) | queued with the reason; thrown so the job backs off (about 2 h over 8 attempts) | `failed` on the last attempt |

RetryAt does not spend a job attempt for up to five waits in a row ([jobs](./jobs.md#retryat-retry-at-a-specific-time));
after that each wait counts, so a delivery that keeps waiting ends `failed` rather than looping.

Reasons come from the Discord client already redacted (never the bot token).

### Known limits

- A run that crashes after Discord accepted the message but before `sent` is written sends it again
  on retry (at-least-once; Discord has no idempotency key for messages).
- Two overlapping runs of one job (a reclaimed lock) can both send before either settles.
- Waits caused by a long burst to one channel spend job attempts after five in a row, so a very
  large burst can fail its tail deliveries; the per-channel bucket keeps them from hammering Discord.

## Env

| Var | Meaning |
|---|---|
| `DISCORD_BOT_TOKEN` | The Mocco bot's token. Without it the runner's Discord client is undefined and deliveries wait (step 4). |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | The bot install OAuth pair. With the bot token, they enable the install routes. |

All are optional; a deployment without them boots.

## Testing

`DeliveryService.test.ts` runs the real `DiscordApi` over `createFakeDiscordFetch` (scripted
replies) on pglite and covers every result mapping, the buckets, fairness and idempotency.
`NotificationService.test.ts` publishes through the real bus (`createEventBus`) and covers fan-out,
filters, redelivery and tenant isolation. `runtime/jobs.test.ts` runs a gate event through the tick
to a sent Discord message. Seed helpers are in `domain/notification/testing/seed.ts`.

`DiscordInstallService.test.ts` and `transport/ext/discord.test.ts` use `createFakeDiscordOAuth`
(valid, consumed, expired and foreign states; the guild from the exchange, not the query).
`ChannelService.test.ts` and the router test use `createTestChannelService` (a real `DiscordApi` over
the fake fetch); the router test sweeps every procedure for cross-tenant `NOT_FOUND` and for the
member/admin split.
