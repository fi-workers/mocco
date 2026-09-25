---
title: Notifications core implementation plan
description: Plan for the notification core (#117 part 1) — channels, rules, deliveries and Discord rate limit tables, the pure rule matcher and templates, the fan-out subscriber and the notification.deliver job with the Discord failure policy.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, notifications, discord]
related:
  - ../specs/2026-09-25-notification-relay-design.md
  - ../../reference/notifications.md
  - ./2026-09-25-discord-client.md
  - ./2026-09-25-domain-events.md
---

# Notifications core implementation plan

Part of #117 (platform foundations §12 F9, notification relay design §6–§8). Stacked on the domain
events slice (#254) and the Discord client (#253). Part 2 (below) adds the Discord install flow, the
channel picker, the `notification` tRPC router and the default rule presets
(`feat/notification-discord-install`).

## Tasks

1. **Schema** (one migration): `mocco_notification_channels` (unique `(workspace_id, kind,
   external_id)`, status check), `mocco_notification_rules` (composite FK to the channel's
   workspace, unique rule per channel, `source_id` without FK until the inbound sources table),
   `mocco_notification_deliveries` (unique `(event_id, channel_id)`, event FK cascades with the
   30-day prune, channel/rule FKs set null, the rendered `message`), `mocco_discord_rate_limits`.
2. **Constants in `@mocco/common/notification`**: `ChannelKinds`, `ChannelStatuses`,
   `DeliveryStatuses`, `discordChannelConfigSchema`, `ruleFilterSchema`.
3. **Pure matcher** `rules.ts`: `isRuleMatch`, `explainNoMatch` (TDD, unit tests).
4. **Pure templates** `templates.ts`: governance events rendered from their payloads (requirements,
   failed step, logs link, trigger), inbound events pass their `payload.message` through a parse.
5. **Repos**: channel, rule, delivery (`createQueued` runs the caller's enqueue in the insert
   transaction; `updateQueued` never touches a settled row), Discord rate limit (`greatest` upsert).
6. **Fan-out** `NotificationService.handle`, registered through `registerNotificationSubscribers`
   in `createEventBus` for `gate.*`, `run.*`, `sentry.*`, `vercel.*`, `github.*`.
7. **Delivery** `DeliveryService.deliver` + `createNotificationHandlers` in `runtime/jobs.ts`:
   buckets, fairness, result mapping, last-attempt settling.
8. **Env**: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` (optional);
   `createDiscordApiFromEnv` returns undefined without the token.
9. **Docs**: `reference/notifications.md`, env and events references, index.

## Decisions

- **Deliveries cascade with their event.** Events are pruned at 30 days; keeping deliveries past
  their event would leave an activity trace without its event. The rendered message is stored on
  the delivery, so a queued delivery never needs to re-read the event.
- **No Discord token → wait, then fail.** The delivery waits an hour at a time (logged) and is
  failed on the job's last attempt. Channels can only be created with Discord configured, so this
  is an operator mistake worth time to fix, but a delivery must not stay `queued` behind a dead job.
- **Sender-level rejection pauses everyone for an hour** through the `global` bucket, and the
  delivery stays queued: the bot token or egress is Mocco's problem, not the tenant's.
- **Fairness waits for the window**: over 120 sends in 60 s, the delivery retries when the oldest
  send leaves the window, instead of a fixed short delay.
- **Matcher is named `isRuleMatch`** (lint: boolean functions start with `is`).
- **Inbound types are not added to the catalog here**: the ingest slice (#243) adds them. The
  prefix subscriptions exist now and receive events once those types land; the inbound template
  branch parses `payload.message` at runtime and is tested with a hand-built event.

## Part 2: Discord install, channels and the router (`feat/notification-discord-install`)

1. **Schema** (migration `0016`): `mocco_discord_guilds` (unique per workspace and guild, installer
   set null) and `mocco_discord_connect_states` (the GitHub connect-state shape).
2. **`DiscordInstallService`**: `startInstall(userId, workspaceId)` → authorize URL with a
   single-use, 10-minute state; `completeInstall(state, code, userId)` consumes atomically,
   exchanges through the `DiscordOAuth` port, upserts the guild from the token response.
3. **`ChannelService`**: guilds, a guild's text channels, channels create (bound only when the bot
   lists the channel in the workspace's guild; test message result returned; unreachable →
   disabled) / delete / re-enable, rules list / add / remove, `applyDefaultRules` with the presets
   from `rulePresetRules`, recent deliveries.
4. **Hono** `transport/ext/discord.ts`: `GET /discord/install`, `GET /discord/callback`, `503`
   without the Discord env.
5. **tRPC** `notification` router: member reads, owner/admin writes through
   `WorkspaceService.assertAdmin` (new; `WorkspaceRoles` in `@mocco/common/workspace`).
6. **Tests**: `createFakeDiscordOAuth`, install service and routes, channel service, router
   cross-tenant and role sweeps.

Decisions:

- **The client names a guild by Mocco's row id and a channel by Discord's id, and the channel must
  be listed by the bot in that guild.** The bot is shared, so trusting a channel id alone would let
  a workspace post into any server the bot is in.
- **A failed test message still stores the channel** (disabled when the bot cannot reach it), so the
  reason sits next to the channel and re-enable is one action after the fix.
- **Install is member-level, channel writes admin-level**, as the task specifies: installing the
  bot only records a guild; nothing is sent until an admin creates a channel.

## Verification

`yarn verify` (format, docs lint, lint, tests on pglite, migration drift, build).
