---
title: MCP surface for notification setup
description: Design for Mocco's first MCP server — a stateless Streamable HTTP endpoint on the Hono ext surface, authenticated by workspace-scoped secret API keys (the first slice of the platform's API keys, #113), exposing the notification relay's sources, channels, rules and activity trace as tools that delegate to the same domain services as tRPC. Used first to migrate the team's discord-relay onto Mocco.
type: spec
status: draft
phase: design
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, design, mcp, api-keys, notifications]
related:
  - ./2026-09-25-notification-relay-design.md
  - ../../specs/2026-09-24-platform-foundations-design.md
  - ../../adr/0011-external-api-surface-architecture.md
---

# MCP surface for notification setup

## 1. Purpose

Let an agent (Claude Code, Claude Desktop, any MCP client) set up and inspect a workspace's
notification relay: create sources, bind Discord channels, edit rules, and answer "why didn't it
arrive?" from the activity trace. The first user is the team itself: the migration of
`fi-workers/discord-relay` onto Mocco (relay spec §11) is done through this surface.

The MCP server is a transport, like tRPC and the Hono ext routes. It carries no business logic:
every tool parses its input and calls the same domain service method the tRPC router calls.

## 2. Decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| 1 | Transport | MCP **Streamable HTTP**, stateless (no session id, no SSE resumption), `POST /api/ext/mcp` on the Hono ext app | stdio package (needs a local install and a key anyway); stateful sessions (serverless has no sticky instances) |
| 2 | Auth | `Authorization: Bearer mk_sec_…`, a **secret API key** from the platform's API key design (#113), hashed at rest, shown once | MCP OAuth 2.1 authorization server (a full OAuth AS is a large surface; revisit when third-party clients need consent screens) |
| 3 | Key scope | Keys may be **workspace-scoped** (`project_id` null) because notifications are workspace-level; scopes `notifications:read`, `notifications:write` | Project-only keys (F8's default; no project owns a Discord channel) |
| 4 | Who can mint | Owner or admin, in the workspace settings; creation and revocation write audit entries | Any member |
| 5 | Authority at call time | The key's scopes **and** the creator still being owner/admin of the workspace (checked per request); a demoted or removed creator's keys stop working | Scopes alone |
| 6 | SDK | `@modelcontextprotocol/sdk`, exact-pinned, imported only in `transport/ext/mcp/` (vendor isolation) | Hand-rolled JSON-RPC |
| 7 | Discord install | Not doable over MCP (it is a browser OAuth consent). The `discord_install_url` tool returns a URL for the human to open | — |

## 3. Keys (first slice of #113)

Table `mocco_api_keys` as in the foundations §11 with one change: `project_id` is nullable, with a
CHECK that `kind = 'secret'` when it is null (publishable keys always identify a project).

- Token format: `mk_sec_` + 32 random bytes base64url. Stored: `sha256(token)` (`token_hash`,
  unique), `last4`, `name`, `scopes text[]`, `created_by_user_id`, `last_used_at`, `expires_at`,
  `revoked_at`.
- `ApiKeyService.create(workspaceId, { name, scopes, expiresAt? })` → `{ key, token }` (token once);
  `list` (no hash, no token), `revoke`.
- `ApiKeyService.authenticate(token)` → `{ workspaceId, projectId, keyId, scopes, createdByUserId }`
  or a domain error: hash lookup, reject revoked/expired, then assert the creator's current role is
  owner or admin (via `WorkspaceService.callerRoles`' underlying lookup by user id, not headers).
  `last_used_at` is updated at most once per minute.
- Rate limiting (the foundations' `RateLimiter`) is not built here; MCP requests are bounded by the
  per-key concurrency of the client and the existing quotas. Noted as a gap.
- Audit: `apikey.created`, `apikey.revoked` added to `AuditActions`.
- UI: a small "API keys" section in workspace settings (create with name + scopes, show token once,
  list, revoke).

## 4. Tools

All tools take no `workspaceId`: the key fixes the workspace. Write tools need
`notifications:write`; read tools `notifications:read`. Destructive tools carry
`destructiveHint: true`; reads carry `readOnlyHint: true`.

| Tool | Delegates to | Notes |
|---|---|---|
| `list_sources` | `SourceService.list` | ingest URLs included; never secrets |
| `create_source` `{kind, name, secret?}` | `SourceService.create` | GitHub returns the generated secret once in the tool result |
| `rotate_source_secret` `{sourceId, secret?}` | `SourceService.rotateSecret` | destructive (old secret stops working) |
| `set_source_status` `{sourceId, status}` | pause/resume | |
| `delete_source` `{sourceId}` | `SourceService.delete` | destructive |
| `discord_install_url` | `DiscordInstallService.startInstall` (as the key creator) | returns a URL for a human |
| `list_discord_servers` / `list_discord_channels` `{guildId}` | `ChannelService` | |
| `list_channels` | `ChannelService` | status + disabled reason |
| `connect_channel` `{guildId, channelId, name?}` | `ChannelService.create` | returns the test-message result |
| `reenable_channel` / `delete_channel` `{channelId}` | `ChannelService` | delete is destructive |
| `list_rules` `{channelId}` / `add_rule` `{channelId, eventType, sourceId?, filter?}` / `remove_rule` `{ruleId}` / `apply_default_rules` `{channelId, preset, sourceId?}` | `ChannelService` | |
| `list_activity` `{sourceId?, channelId?, outcome?, limit?, beforeSeq?}` | the activity read model (#244) | includes rule-mismatch explanations |
| `list_event_types` | the events catalog | so an agent can write rules without guessing names |

Tool results are JSON text content plus `structuredContent` with an `outputSchema` (zod → JSON
Schema), so clients can use either.

## 5. Transport details

- `transport/ext/mcp/server.ts` builds an `McpServer` per request (stateless) with the tools bound
  to the authenticated principal; `transport/ext/mcp/route.ts` mounts it on `POST /api/ext/mcp`
  (`GET`/`DELETE` → 405, as stateless servers do). Only files under `transport/ext/mcp/` import the
  SDK (lint rule, like hono and octokit).
- Auth middleware runs before the SDK sees the body: missing/invalid key → `401` with
  `WWW-Authenticate: Bearer`; insufficient scope → a tool error result (`isError: true`) naming the
  missing scope, never a stack or SQL.
- Domain errors map to tool errors with their safe message (the same per-domain mapping as the
  routers, via a small MCP error mapper colocated with the tools).
- `maxDuration` of the ext route already covers tool calls; tools that call Discord inherit its 5 s
  timeout.

## 6. Client setup (goes in the customer guide)

```bash
claude mcp add --transport http mocco https://www.mocco.club/api/ext/mcp \
  --header "Authorization: Bearer mk_sec_…"
```

## 7. Testing

- `ApiKeyService` on pglite: create/list/revoke, hash only at rest, token once, expired/revoked,
  demoted creator → rejected, `last_used_at` throttle.
- MCP over `app.fetch` with the SDK's client transport against the Hono app: initialize, list
  tools, call each tool against real services on pglite with the Discord fakes; 401 without key;
  scope errors; tenant isolation (a key for workspace A never sees B's sources); no secret in any
  result except the one-time GitHub secret.

## 8. Migration of the team relay (after this lands)

1. Create a key for the team workspace; add the MCP server to Claude Code.
2. Through MCP: create Sentry, Vercel and GitHub sources; install the bot (URL tool, human
   consents); connect the three channels the relay posts to; apply default presets per source.
3. Paste the ingest URLs and secrets into Sentry, Vercel and GitHub **next to** the relay's; watch
   `list_activity` and the channels for a few days with both running.
4. Remove the relay's URLs and shut it down (after stage0, #245, is live).

## 9. Out of scope

OAuth for MCP; publishable keys and `/v1`; rate limiting; MCP resources/prompts; tools for
governance (runs, gates) — a later slice can add them on the same server.
