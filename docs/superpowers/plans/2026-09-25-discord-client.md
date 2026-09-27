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

1. Render one embed: the severity picks the color and the title emoji. The prefix is charged to the
   256-character title and to the 6000-character total; a message that would overflow gives up the
   difference from its description, or drops the prefix when there is no description long enough.
   Links (`url`, author `url` / `icon_url`) that are not http(s) are dropped.
2. Post with `allowed_mentions: { parse: [] }`, so customer text never pings anyone.
3. Classify without throwing:
   - 2xx: `sent`, with the `channel:<id>` bucket and `blockedUntil` when `X-RateLimit-Remaining` is 0
     (from `Reset-After`, else `Reset` in epoch seconds). DELETE shares the POST channel bucket.
   - 429 from Discord: `rate_limited`, retrying at `retry_after` (then `Retry-After`, then
     `Reset-After`, then 60 s), on the global bucket when the limit is global, and flagged `shared`
     for a shared-scope limit.
   - 429 with no `X-RateLimit-Scope` and no Discord JSON body (a Cloudflare IP ban): global, retrying
     after at least `DISCORD_CLOUDFLARE_BAN_RETRY_SECONDS` (15 minutes).
   - Codes 50001, 50013, 10003, 10004: `permanent`, disabling the channel.
   - 401, a 403/404 with no code or code 0, and 40333 (Cloudflare block): `permanent`, disabling the
     sender, so a bad route, User-Agent or block stops everything once.
   - Anything else in 4xx (400 / 50035, 10008 on a canary delete): `permanent`, disabling nothing.
   - 5xx, a timeout (AbortController, 5 s default, combined with the caller's signal) or a network
     error: `transient`.
4. Reasons carry only the status, Discord's `code` and `message`, redacted of the bot token (or the
   client secret for OAuth), with NUL removed and a length cap.
5. OAuth: authorize with `scope=bot identify`, `permissions=84992`, `integration_type=0`,
   `response_type=code`; exchange the code form-encoded with HTTP Basic client credentials and take
   the guild from the token response's `guild` object only. A 429, 5xx or timeout is `transient`.

## Verification

Vitest against the fake fetch: rendering per severity, request shape, every status and JSON code
branch, the timeout and network error paths, token redaction across all results, channel filtering
and ordering, the authorize URL and the exchange outcomes. `yarn verify` green.
