---
title: Notification relay — inbound webhooks to Discord, on the platform foundations
description: Design for the notification relay product feature — customers connect Sentry, Vercel and GitHub through per-workspace signed ingest URLs, Mocco itself is a fourth source, and events are filtered and delivered to Discord by the official Mocco bot with retries and a "why didn't it arrive" trace. Built on SecretBox, the job queue, domain events and notifications (epic #106).
type: spec
status: draft
phase: design
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, design, notifications, discord, webhooks, inbound]
related:
  - ../../specs/2026-09-24-platform-foundations-design.md
  - ../../reference/roadmap.md
  - ../../adr/0005-tech-stack-vercel-native-next-fullstack.md
  - ../../adr/0011-external-api-surface-architecture.md
  - ./2026-07-13-slice3-github-integration-observation-design.md
---

# Notification relay — inbound webhooks to Discord

## 1. Purpose

Customers connect their Sentry, Vercel and GitHub accounts and get the events that matter posted to
their Discord channels. Mocco's own governance events (gate pending/resumed/rejected, run failed)
are a fourth source on the same pipeline.

The team's existing tool, `fi-workers/discord-relay` (one Vercel Edge Function, `core.mjs`), is the
prototype: it proved the per-source filters and message shapes, and it taught three lessons that
shape this design:

1. **Sources give little time and rarely retry.** Sentry expects a response within 1 second and
   documents no retry; GitHub never retries automatically (manual redelivery only, 3-day window);
   Vercel retries for 24 hours. Waiting on Discord before answering lost 7 of 56 Sentry deliveries.
   The relay then answered first and delivered in `waitUntil`, so its 200 meant "received", not
   "delivered", and failures were only logged.
2. **Optional signature checks stay off.** The relay verified HMAC only when a secret was set, and
   ran unverified for months.
3. **Nobody could answer "why didn't it arrive?"** There was no record of what was received,
   filtered, retried or dropped.

This is a standalone product feature: a customer who never uses Mocco's deploy governance can use
it on its own. It is **not** a port of the team tool; the team tool is migrated onto it at the end
(section 11).

## 2. Decisions from brainstorming (2026-09-24/25)

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| 1 | Product role | Collect webhooks, filter, format, deliver to Discord. Standalone (no governance required) | Governance-only helper |
| 2 | Cross-source correlation ("deploy #42 then errors spiked") | Deferred to a later release; the event log built here is its base | In v1 |
| 3 | Source connection | Per-workspace ingest URL + per-source secret, **signature mandatory**, for all three sources (GitHub included, so the governance GitHub App stays read-only) | Marketplace/App installs (Sentry review, Vercel approval, widening the GitHub App's scopes) |
| 4 | Destination | Official Mocco Discord bot, installed by the customer; they pick channels in Mocco. Model leaves room for a customer-supplied bot token later | Channel webhook URLs pasted by the customer; customer bot token in v1 |
| 5 | Governance events | Same feature: Mocco is a source like the others, on v1 | Separate governance notifier |
| 6 | Pricing | Deferred. v1 has protective per-workspace limits and counts events so plans can sit on top later | Plans now |
| 7 | Delivery engine | Postgres job table + tick (the platform job queue, F4), `waitUntil` kick for immediate delivery | Vercel Queues, Inngest |
| 8 | Foundation alignment | Build on the platform foundations: SecretBox (#110), job queue (#111), domain events (#112), notifications (#117, **Discord sender first instead of Slack**) | A relay-private pipeline |
| 9 | Customer guides | Written alongside every slice, with real screenshots, as Markdown in the repo rendered by the app | Written at the end |
| 10 | Mocco's own alerts | Dogfood: move the team relay onto Mocco (after the MCP surface exists), with a "stage0" watchdog outside Mocco that fires when Mocco goes silent | Keep the old relay for Mocco's own alerts |

Slack is not in v1. The `Sender` interface from F9 keeps it a later leaf.

## 3. Where this sits in the platform foundations

The platform foundations design (`docs/specs/2026-09-24-platform-foundations-design.md`) already
specifies most of what this feature needs. This spec adds only what is new and names the
changes to the foundations.

```
[Sentry/Vercel/GitHub] --POST /api/ext/inbound/<ingestKey>--> InboundService   (new, section 5)
                                                                   |
[governance services] ----------------------------------------> EventBus.publish (F12, #112)
                                                                   |
                                                    NotificationService (F9, #117)
                                                    rules match -> delivery rows -> jobs (F4, #111)
                                                                   |
                                                    DiscordSender (new leaf, section 6)
```

Changes to the foundations, applied in their slices:

- **F9 (#117):** add channel kind `discord`; the first sender is Discord, not Slack. Slack stays in
  the design for a later slice.
- **F9 rules:** `filter` is a flat equality match over the event's `facts` (section 7).
- **F12 (#112):** v1 ships the bus, the catalog and the governance event types. The release
  registry and `deploy.released` stay in #112 but are not needed by this feature.
- **F4 (#111):** a handler can ask to be retried at a specific time (Discord's `retry_after`)
  instead of the generic backoff.

Build order (each a PR, landed sequentially after open PR #242):

1. SecretBox (#110)
2. Job queue and tick (#111)
3. Domain events: bus, catalog, governance events (#112, partial)
4. Notifications core: channels, rules, deliveries, `Sender` port (#117, part 1)
5. Discord: bot install, channel picker, sender, rate limits (#117, part 2)
6. Inbound sources: ingest route, Sentry/Vercel/GitHub adapters (#243)
7. Notifications UI: channels, sources, rules, activity trace (#244)
8. Customer guides rendered in the app, with screenshots (#244)
9. Stage0 canary and heartbeat (#245)
10. MCP surface (its own spec, #246)
11. Migration of the team relay (operations, section 11, #246)

## 4. Domain events added by this feature

The F12 catalog (`@mocco/common/events`) gains inbound types. Each payload has the same shape so
rules and templates treat all sources alike:

```ts
{
  sourceId: string,              // mocco_inbound_sources.id (absent for Mocco's own events)
  facts: Record<string, string | boolean>,  // flat, filterable (section 7)
  message: NeutralMessage,       // rendered once at ingest, sender-agnostic
}

NeutralMessage = {
  title: string,                 // <= 256 chars
  url?: string,
  description?: string,          // <= 2000 chars
  severity: 'info' | 'success' | 'warning' | 'error',
  fields: { name: string, value: string, inline?: boolean }[],   // <= 10
  actor?: { name: string, url?: string, avatarUrl?: string },
  footer: string,
}
```

Event types and the facts each carries:

| Type | Facts |
|---|---|
| `sentry.issue.created` | `project`, `environment`, `level` |
| `vercel.deployment.created` / `.succeeded` / `.error` / `.canceled` | `project`, `target` (`production`/`preview`), `branch` |
| `github.push` | `repo`, `refType` (`branch`/`tag`), `branch` (branch pushes only), `hasCommits` |
| `github.pull_request.opened` / `.reopened` / `.merged` / `.closed` | `repo`, `baseBranch` |
| `github.issues.opened` / `.reopened` / `.closed` | `repo` |
| `github.release.published` | `repo` |
| `github.workflow_run.failed` / `.succeeded` | `repo`, `branch`, `workflow` |
| `gate.pending` / `gate.resumed` / `gate.rejected`, `run.failed` | `repo`, `pipeline` (governance, from #112) |

Payloads the adapters do not map (Sentry `resolved`, GitHub `ping`, `star`, …) produce no event;
the receipt records `ignored` with the reason (section 5).

## 5. Inbound sources (new)

### Tables

```
mocco_inbound_sources
  id uuid pk, workspace_id → workspaces (cascade)
  kind text CHECK IN ('sentry','vercel','github')
  name text                                  -- customer label, e.g. "Acme web"
  ingest_key text UNIQUE                     -- 32 random bytes, base64url; the URL path segment
  secret_sealed text                         -- SecretBox, aad = 'mocco_inbound_sources:<id>'
  status text CHECK IN ('active','paused') default 'active'
  last_received_at timestamptz null, created_at, updated_at

mocco_inbound_receipts
  id uuid pk, seq bigserial, workspace_id, source_id → sources (cascade)
  external_id text                           -- the source's delivery id (dedupe)
  source_event text                          -- e.g. 'issue.created', 'deployment.succeeded', 'push'
  outcome text CHECK IN ('published','ignored','over_quota','pending')
  reason text null                           -- why ignored, e.g. 'sentry action "resolved" is not mapped'
  event_type text null, domain_event_id uuid null
  normalized jsonb null                      -- the event payload, kept so a stuck 'pending' can be republished
  received_at timestamptz default now()
  UNIQUE (source_id, external_id)
  INDEX (workspace_id, seq DESC)
```

`ingest_key` is an unguessable identifier, not a credential: every request must also carry a valid
signature made with the source's secret. Tenant resolution is `ingest_key → source → workspace`,
never a value inside the payload.

### Signatures and secrets per source

| Kind | Where the customer configures it | Secret comes from | Header, algorithm | Delivery id |
|---|---|---|---|---|
| Sentry | Settings → Developer Settings → Custom Integration (internal), webhook URL + "issue" resource | Sentry shows the integration's Client Secret; customer pastes it into Mocco | `Sentry-Hook-Signature`, HMAC-SHA256 hex of the body | `Request-ID` header |
| Vercel | Team Settings → Webhooks (Pro/Enterprise only) | Vercel shows the webhook secret once; customer pastes it | `x-vercel-signature`, HMAC-SHA1 hex of the body | payload `id` |
| GitHub | Repo or org Settings → Webhooks, content type JSON | Mocco generates it and shows it; customer pastes it into GitHub | `X-Hub-Signature-256`, `sha256=` + HMAC-SHA256 hex | `X-GitHub-Delivery` |

A source row is created with its secret. There is no "verification off" state. A source without a
usable secret cannot be saved. The secret can be replaced (rotation) but never read back through
tRPC; the create/rotate response for GitHub returns the generated secret once.

### Ingest flow (`POST /api/ext/inbound/:ingestKey`)

1. Read the raw body as bytes (`arrayBuffer()`; see Source adapters for why not `text()`). Look up the source by `ingest_key`; unknown or paused → `404`
   with no detail.
2. Open the secret, verify the signature for the source's kind (constant-time compare). Invalid →
   `401`, nothing written.
3. Take the delivery id; missing → `400`.
4. Parse with the source adapter (pure, no I/O): the result is either an event (type, facts,
   message) or an `ignored` reason.
5. Insert the receipt in one statement with the parse result: `outcome = 'pending'` and
   `normalized` for an event, `outcome = 'ignored'` and `reason` otherwise
   (`ON CONFLICT (source_id, external_id) DO NOTHING`). A conflict means a redelivery → `202`
   without further work. Ignored → `202`.
6. Quota check: more than `INBOUND_DAILY_LIMIT` (constant, 5,000) published receipts for the
   workspace in the last 24 hours → mark `over_quota` → `202`. Sources do not retry reliably, so
   the request is still answered as accepted and the trace shows the drop.
7. Publish the domain event, mark the receipt `published` with `domain_event_id` → `202`.

Steps 1–7 run on the request path. They are a handful of indexed queries and one AES-GCM open, so
they fit Sentry's 1-second budget on a warm function. Delivery to Discord never runs on this path.
`202` therefore means "recorded", which is stronger than the relay's "received". A crash between
steps 5 and 7 leaves a `pending` receipt that already holds `normalized`; the scheduled job
`inbound.republish-stale` (every minute) publishes `pending` receipts older than 60 seconds. The
publish is idempotent on the receipt id (the event's dedupe key), so a republish racing a slow
original does not double-deliver.

Retention: receipts older than 30 days are pruned by a daily job, matching domain events.

### Source adapters (pure, no vendor SDK)

`packages/backend/src/domain/inbound/sources/{sentry,vercel,github}.ts`, each exporting:

```ts
verify(rawBody: Uint8Array, headers: Headers, secret: string): boolean   // HMAC over the exact received bytes
decodeBody(rawBody: Uint8Array): string | undefined                       // strict UTF-8; undefined → ignored
deliveryId(body: string, headers: Headers): string | undefined
parse(body: string, headers: Headers): { kind: 'event'; type; facts; message } | { kind: 'ignored'; reason }
```

The route reads the body with `arrayBuffer()`, not `text()`: `text()` strips a byte-order mark and
replaces invalid UTF-8, so the bytes it would re-encode are not always the bytes the vendor signed.
Every string that reaches the DB is sanitized (well-formed UTF-16, no `\u0000`), and lookups by
payload-controlled names are own-property guarded.

Payloads cross the boundary only through zod `safeParse` (lenient schemas: only the fields used).
The relay's filters move here as *mapping* (which payloads become which event types), while the
*filtering* (which event types a channel wants) moves to notification rules, so customers can
change it. The relay's embed builders become `NeutralMessage` builders; colors and emoji move to
the Discord leaf, keyed by `severity`.

Fixtures: the relay's test payloads plus payloads captured from real deliveries, stored under
`domain/inbound/testdata/`.

## 6. Discord sender (new leaf in F9)

### Install and channel selection

- Env: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` (optional, like the GitHub
  vars; the Discord surfaces answer "not configured" when absent).
- `GET /api/ext/discord/install?workspaceId=…` (signed-in member) issues a single-use state bound to
  user and workspace (`mocco_discord_connect_states`, same shape as the GitHub connect states) and
  redirects to Discord's OAuth2 authorize URL with `scope=bot identify`, `permissions` =
  View Channel + Send Messages + Embed Links + Read Message History, and the state. Adding a
  non-bot scope makes Discord return a `code`.
- `GET /api/ext/discord/callback` consumes the state, exchanges the code, and takes the guild from
  the token response (not from the `guild_id` query parameter, which is only a hint). Result:
  `mocco_discord_guilds (id, workspace_id, guild_id, guild_name, installed_by_user_id, created_at,
  UNIQUE (workspace_id, guild_id))`.
- The channel picker lists the guild's text and announcement channels with the bot token
  (`GET /guilds/{id}/channels`). Creating a Discord notification channel stores
  `config = { guildId, channelId, channelName }` and **sends a test message**; a permission error
  there is shown to the user immediately instead of surfacing later.
- A later "bring your own bot" option stores a customer bot token in the channel's
  `secret_sealed`; the sender uses it when present, the Mocco bot token otherwise. Not in v1.

### Sending, rate limits, failure handling

`domain/notification/senders/discord.ts` is the only file that calls Discord (plain `fetch`, REST
v10). It renders `NeutralMessage` to one embed (severity → color/emoji) and posts
`POST /channels/{id}/messages`.

- **Per-bucket pacing:** Discord rate limits per route and top-level resource (the channel). The
  sender stores `mocco_discord_rate_limits (bucket text pk, blocked_until timestamptz)` for
  `channel:<id>` and `global`. Before sending it checks both; if blocked, it asks the job queue to
  retry at `blocked_until`. After a response with `X-RateLimit-Remaining: 0` it sets
  `blocked_until = now + X-RateLimit-Reset-After`. A `429` sets the bucket from `retry_after`
  (`global: true` → the global bucket) and retries at that time; it does not count as a failed
  attempt more than 5 times in a row.
- **Permanent failures stop immediately:** `403` / `404` (Missing Access 50001, Missing
  Permissions 50013, Unknown Channel 10003, Unknown Guild 10004) mark the channel `disabled` with
  the reason, fail the delivery without retry, and stop later deliveries to it. Discord bans an IP
  after 10,000 invalid (401/403/429) requests in 10 minutes, and every tenant shares Mocco's egress
  IPs, so one broken channel must not keep hammering. `401` on the Mocco bot token disables the
  whole sender (config error) and alerts operators through stage0.
- **Transient failures retry:** `5xx`, timeouts (5 s) and network errors use the job queue's
  backoff, `max_attempts = 8` (about 2 hours total).
- **Per-workspace fairness:** at most `DISCORD_WORKSPACE_PER_MINUTE` (constant, 120) sends per
  workspace per minute; excess deliveries are rescheduled, not dropped.

## 7. Filtering: notification rules with defaults

F9 rules are `(channel_id, event_type, filter jsonb)`; `event_type` is exact or a prefix wildcard
(`github.*`). `filter` is a flat object; a rule matches when every key equals the event's fact of
the same name (`{"target": "production"}`). No expression language in v1.

When a customer points a source at a channel, Mocco creates the **default rules** for that source,
taken from the relay. Customers can then remove or add rules per channel.

| Source | Default rules |
|---|---|
| Sentry | `sentry.issue.created` |
| Vercel | `vercel.deployment.succeeded` `{target: production}`, `vercel.deployment.error`, `vercel.deployment.canceled` |
| GitHub | `github.push` `{hasCommits: true}`, `github.pull_request.opened`, `.reopened`, `.merged`, `.closed`, `github.issues.opened`, `.reopened`, `.closed`, `github.release.published`, `github.workflow_run.failed` |
| Mocco | `gate.pending`, `gate.resumed`, `gate.rejected`, `run.failed` |

Rules also carry an optional `source_id` so two Vercel sources can go to different channels.

## 8. "Why didn't it arrive?" — the activity trace

One read model joins what already exists: receipt → domain event → deliveries → job attempts.

For each received event the UI shows, per channel of the workspace:

- `ignored` / `over_quota` receipts: the receipt's reason.
- Published but no delivery for a channel: the rule matcher (the same pure function the
  `NotificationService` uses) re-runs against the channel's current rules and explains the
  non-match ("no rule for `vercel.deployment.succeeded` with `target = preview`").
- Delivery rows: status, attempts, last error, response code, next retry time.

Also shown: a source's `last_received_at` and a "no events in N days" hint; a disabled channel's
reason with a reconnect action.

## 9. Transport and UI

- **Hono (`transport/ext/app.ts`):** `POST /api/ext/inbound/:ingestKey`,
  `GET /api/ext/discord/install`, `GET /api/ext/discord/callback`, and the tick route from F4.
- **tRPC:** `inbound` router (create/list/rename/pause/rotate source; no secret in outputs,
  `hasSecret` projection instead) and the F9 `notification` router (channels, rules, activity).
  Writes require owner or admin; reads require membership.
- **UI:** `/workspaces/[id]/notifications` with three tabs, state in the URL (`?tab=`):
  **Channels** (connect Discord, pick channels, rules per channel), **Sources** (add source →
  ingest URL + secret + setup steps with a guide link; last received), **Activity** (the trace,
  filter by source/channel/outcome).

## 10. Customer guides

- Markdown under `docs/customer/notifications/` with screenshots in `docs/customer/notifications/images/`:
  `overview.md`, `connect-discord.md`, `sentry.md`, `vercel.md`, `github.md`, `mocco-events.md`,
  `troubleshooting.md` (reads like the activity trace: each outcome and what to do).
- Rendered by the app at `/docs/notifications/<page>` (static pages, built from the Markdown), and
  linked from the setup screens. The help center product (#96) can later take the same files.
- Every slice that changes a customer-visible step updates its guide page and screenshots in the
  same PR. Screenshots are taken with `agent-browser`; vendor settings screens are captured up to
  the form, without saving on real accounts.
- English, like all repo content.

## 11. Dogfooding: moving the team relay onto Mocco

The team relay today posts Mocco's own Sentry/Vercel alerts too. Moving those onto Mocco means
Mocco could not report its own outage, so a **stage0 watchdog** lands first:

- A schedule `stage0.canary` (every 5 minutes) sends a signed synthetic request **over HTTP** to the
  ingest URL of a designated canary source (so the public route, the function, the DB and the
  queue are all exercised), which a rule routes to a private canary channel. The Discord sender
  deletes canary messages right after they post.
- When a canary delivery is `sent`, the handler pings `OPS_HEARTBEAT_URL` (an external dead-man
  switch such as healthchecks.io). If pings stop for 15 minutes, that service alerts the team
  through its own Discord integration, outside Mocco.
- Env: `OPS_HEARTBEAT_URL`, `OPS_CANARY_SOURCE_ID` (both optional; stage0 is off without them).

Migration steps (after the MCP surface exists, operations, not code):

1. Turn on stage0 and watch it for a few days.
2. Through MCP, create sources for the team's Sentry, Vercel and GitHub, the Discord channels and
   the rules that reproduce today's routing.
3. Add the new ingest URLs next to the relay's in each vendor, so both deliver for a few days.
4. Remove the relay's URLs from the vendors and shut the relay down.

## 12. Layering and files

```
packages/backend/src/
  infra/crypto/secret-box.ts                 (#110)
  domain/jobs/                               (#111)
  domain/events/                             (#112)
  domain/notification/
    NotificationService.ts, ChannelService.ts, rules.ts (pure matcher), templates/
    senders/discord.ts                       only file calling Discord
    DiscordInstallService.ts                 state + code exchange + guild binding
    repos/*.repo.ts
  domain/inbound/
    InboundService.ts, SourceService.ts, constants.ts
    sources/{sentry,vercel,github}.ts        pure adapters
    repos/*.repo.ts, testdata/
  transport/ext/app.ts                       new routes
  transport/trpc/routers/{inbound,notification}.ts
packages/common/src/{events,notification,inbound}.ts
packages/frontend/src/pages/workspaces/[id]/notifications.tsx
packages/frontend/src/pages/docs/notifications/[page].tsx
docs/customer/notifications/
```

Vendor calls are plain `fetch` in one leaf per vendor (`senders/discord.ts`; the Discord OAuth
exchange lives in `DiscordInstallService` behind a `DiscordOAuth` port so it is fakeable). No new
SDK dependency.

## 13. Testing (pglite, fakes, no `vi.mock`)

- Source adapters: fixture payloads → expected event type, facts and message; signature
  verification with known-good and tampered bodies for each algorithm.
- `InboundService` on pglite with a real SecretBox (test key) and a recording `EventBus`:
  dedupe on redelivery, quota, ignored reasons, pending republish, and **tenant isolation** (two
  workspaces with sources of the same kind; a request to one ingest key never publishes for the
  other).
- Rule matcher: pure unit tests, including the explanation text used by the trace.
- Discord sender against a `FakeDiscordApi` (a small in-process `fetch`-compatible fake that
  scripts responses): pacing from headers, 429 local and global, 403/404 disabling the channel,
  5xx retry, canary delete.
- Discord install: `FakeDiscordOAuth` port; valid state → guild bound; consumed/expired state →
  rejected; guild taken from the exchange response, not the query.
- Hono routes via `app.fetch`: 404 unknown key, 401 bad signature with zero writes, 202 paths.
- Error hygiene: no secret, token or signature in any error, log line or tRPC output.

## 14. ADRs

- **ADR 0014 — Background jobs on a Postgres job table driven by a tick** (from the platform
  foundations; lands with #111).
- **ADR 0018 — Domain events vs audit log** (from the platform foundations; lands with #112).
- **ADR 0019 — Inbound webhooks use per-source ingest URLs with mandatory signatures** (new): why
  not marketplace installs in v1, tenant resolution by URL key, secrets sealed, no unverified mode,
  answer-after-record semantics (202 means recorded).
- **ADR 0020 — Mocco's own alerts go through Mocco, guarded by an external stage0 heartbeat**
  (new): the bootstrap argument and what the watchdog must cover.

Numbers follow the foundations' provisional list and are fixed at write time.

## 15. Out of scope for v1

Slack and other senders; marketplace/App installs for sources; customer bot tokens; cross-source
correlation and threads; per-rule expressions beyond equality; message editing; billing plans.
