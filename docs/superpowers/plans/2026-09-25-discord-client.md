---
title: Discord REST client and OAuth exchange implementation plan
description: Plan for the notification relay's Discord leaf — a DiscordApi class that renders a NeutralMessage to one embed and classifies every Discord answer into sent / rate_limited / permanent / transient, plus the bot-install OAuth port — with no DB, services or transport.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, notifications, discord]
related:
  - ../../reference/backend-conventions.md
  - ./2026-09-25-inbound-adapters.md
---

# Discord REST client implementation plan

Part of #117 (notification relay, spec §6 "Discord sender" and §12 "Layering and files"). This slice
lands only the leaf that talks to Discord. The delivery job, the `mocco_discord_rate_limits` pacing
table, channel disabling, the install routes and `DiscordInstallService` come in later PRs and
consume these results.

## Files

- `packages/backend/src/domain/notification/senders/discord-constants.ts`: every Discord number and
  header name (permission bits, JSON error codes, channel types, rate limit headers and scopes,
  severity styles), each group citing the developer docs page it comes from.
- `packages/backend/src/domain/notification/senders/discord.ts`: `DiscordApi` (`sendMessage`,
  `deleteMessage`, `listTextChannels`) plus `timedFetch`, the single place a Discord request is made.
- `packages/backend/src/domain/notification/senders/discord-oauth.ts`: the `DiscordOAuth` port and
  `createDiscordOAuth` (authorize URL, code exchange).
- `packages/backend/src/domain/notification/testing/fake-discord-fetch.ts`: a scripted, recording
  `fetch` injected through the constructor (no module mocking).

## Behaviour

1. Render one embed: the severity picks the color and the title emoji; the prefix is charged to the
   title so the embed stays within Discord's 256-character title and 6000-character total.
2. Post with `allowed_mentions: { parse: [] }`, so customer text never pings anyone.
3. Classify without throwing:
   - 2xx: `sent`, with the `channel:<id>` bucket and `blockedUntil` when `X-RateLimit-Remaining` is 0.
   - 429: `rate_limited`, retrying at `retry_after` (then `Retry-After`, then `Reset-After`, then 60 s),
     on the global bucket when the limit is global, and flagged `shared` for a shared-scope limit.
   - 401: `permanent`, disabling the sender. 403, 404 and codes 50001, 50013, 10003, 10004:
     `permanent`, disabling the channel. 10008 (unknown message, a canary delete): `permanent`,
     disabling nothing. Other 4xx such as 400 / 50035: `permanent`, disabling nothing.
   - 5xx, a timeout (AbortController, 5 s default) or a network error: `transient`.
4. Reasons carry only the status, Discord's `code` and `message`, redacted of the bot token (or the
   client secret for OAuth), with NUL removed and a length cap.
5. OAuth: authorize with `scope=bot identify`, `permissions=84992`, `integration_type=0`,
   `response_type=code`; exchange the code form-encoded with HTTP Basic client credentials and take
   the guild from the token response's `guild` object only.

## Verification

Vitest against the fake fetch: rendering per severity, request shape, every status and JSON code
branch, the timeout and network error paths, token redaction across all results, channel filtering
and ordering, the authorize URL and the exchange outcomes. `yarn verify` green.
