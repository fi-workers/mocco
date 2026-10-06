---
title: Public /v1 API
description: The versioned public API on the ext app — publishable and secret project keys, how requests are authenticated and limited, CORS, problem+json errors, the API host rewrite, and how product routes plug in.
type: reference
status: active
created: 2026-10-01
updated: 2026-10-06
confidence: high
owner: andrea
tags: [reference, platform, api, api-keys, rate-limiting]
related:
  - ../adr/0017-public-v1-api-keys-and-sdk-licensing.md
  - ./env.md
code_refs:
  - packages/backend/src/domain/apikey/ApiKeyService.ts
  - packages/backend/src/domain/ratelimit/PostgresRateLimiter.ts
  - packages/backend/src/transport/ext/v1/middleware.ts
  - packages/backend/src/transport/ext/v1/routes.ts
  - packages/common/src/apikey.ts
  - packages/common/src/help-v1.ts
  - packages/backend/src/transport/ext/v1/help.ts
  - packages/backend/src/transport/ext/v1/status.ts
  - packages/backend/src/transport/ext/v1/status-openapi.ts
  - packages/common/src/status-v1.ts
  - packages/backend/src/transport/ext/v1/status-subscribers.ts
---

# Public /v1 API

> Decided in [ADR 0017](../adr/0017-public-v1-api-keys-and-sdk-licensing.md). Customer servers, apps and SDKs call `/api/ext/v1/*`, or `https://<PUBLIC_API_DOMAIN>/v1/*` when that host is configured. tRPC stays internal.

## Keys

A key belongs to one project and has a kind:

| Kind | Token | Where it lives | Scopes |
|---|---|---|---|
| Publishable | `mk_pub_` + 32 base62 characters | Web and React Native apps | Client scopes only: `ota:read`, `flags:read`, `messenger:chat` (it acts only for a user the app's server signed), `help:read` |
| Secret | `mk_sec_` + 32 base62 characters | Servers and CI | Any scope |

`runs:read` is secret-only and read-only. Run history is operational data about a team's deploys, so it never reaches a browser or an app; and a key authenticates a **project**, not a person, so it can watch a deploy but never resume one — deciding needs someone the audit chain can name ([ADR 0002](../adr/0002-mocco-is-an-independent-authorization-layer.md), [ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)). A run carries no project: it reaches one through its commit's repository and `mocco_project_repos`, so a key sees its own project's repositories and nothing else.

`status:write` and `status:read` are secret-only as well. `status:write` manages the project's monitors, incidents, maintenance and component statuses and makes Mocco check a monitor's target now, which an app has no reason to do; `status:read` reads them, draft incidents and monitor settings included, which is operational data. A key acts for the person who created it, and the audit log names the key ([Status: the /v1 management API](./status.md#the-v1-management-api)).

The token is returned once, by `apiKey.create`, and only its SHA-256 is stored; the console shows `mk_sec_…abcd`. Keys are managed on the project's **API keys** tab (`/workspaces/{id}/p/{projectId}/api-keys`): pick the kind (publishable keys offer only client scopes), name it and choose scopes, copy the token from the one-time notice, and revoke with an inline confirmation. Owners and admins create and revoke keys (`apikey.created`, `apikey.revoked` in the audit log); members can list them. A key may expire (`expiresAt`), and its `lastUsedAt` is updated at most once a minute.

A key with `flags:read` is bound to exactly one flag environment of its project (`flagEnvironmentId`, ADR 0024), and a key without it names none; the database enforces both. The console asks for the environment when `flags:read` is ticked.

## Authentication

Send the key as `Authorization: Bearer <token>` (or `X-Mocco-Key: <token>`). `requireKey({ kinds?, scope? })` resolves it and sets `c.var.principal = { workspaceId, projectId, keyId, kind, scopes }`. Routes scope every query by the principal, never by request input.

| Situation | Answer |
|---|---|
| No key | `401 missing_key` |
| Unknown, revoked or expired key (indistinguishable) | `401 invalid_key` |
| Secret key with an `Origin` header (sent from a browser) | `401 secret_key_from_browser` |
| Publishable key with an `Origin` that isn't one of the project's apps' `webOrigins` | `403 origin_not_allowed` |
| Key kind or scope the route doesn't accept | `403 wrong_key_kind` / `403 insufficient_scope` |

Origins are compared normalised (`https://APP.acme.test:443` equals `https://app.acme.test`). Native apps send no `Origin`; their publishable key is bounded by the rate limit.

## Rate limits

Per key: 600 requests a minute for publishable keys and 1,200 for secret keys. Per client IP (hashed) and route, for routes without a key: 120 a minute. Heartbeat pings and status page sign-ups have their own limits (per token or address and per client address, [below](#routes)). Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds). Over the limit, the answer is `429 rate_limited` with `Retry-After`.

The default driver is Postgres (`mocco_rate_limit_counters`, one upsert per request, fixed windows, pruned hourly by `ratelimit.prune`). Hot cacheable reads (flag rulesets, OTA manifests, version checks) are served from the CDN and limited at the edge instead.

## Errors

RFC 9457 `application/problem+json`: `{ "type": "https://mocco.dev/problems/<code>", "title", "status", "detail"? }`. No vendor or SQL detail.

## CORS

Preflights (`OPTIONS`) are answered for any origin; the real request still has to pass the key's origin check. Responses to a browser expose the rate-limit headers and echo the allowed origin.

## Routes

| Route | Key | Answer |
|---|---|---|
| `GET /v1/ping` | none | `{ "ok": true, "api": "v1" }` |
| `GET /v1/whoami` | any | `{ projectId, kind, scopes }` |
| `GET /v1/apps/{appId}/version-check` | none (CDN-cached) | see [OTA version policy](./ota-version-policy.md) |
| `GET /v1/help/search?q=&locale=&limit=&match=` | `help:read` | The key's project's published help articles matching `q` (every word, or with `match=any` any word, ranked by how many match; title hits first), in `locale` where translated (any language tag; `en-KR` counts as `en`): `{ locale, hits: [{ title, path, url, snippet }] }`; `url` is absolute when the site's domain is configured; 404 without a help center; see [Help center](./help-center.md#search) |
| `GET /v1/help/site?locale=` | `help:read` | The key's project's help center: `{ name, sourceLocale, locales, locale, url, collections: [{ slug, title, description, sections: [{ title, articles: [{ id, slug, title, path, url }] }] }] }`, published articles only; see [Help center](./help-center.md#the-v1-read-api) |
| `GET /v1/help/collections/{slug}?locale=` | `help:read` | `{ locale, collection }`, one published collection as `/site` lists it; `404` for an unknown or empty one |
| `GET /v1/help/articles/{id}?locale=` | `help:read` | A published article by its `id` (the 6-character short id, or the `{id}-{slug}` ref from its path; a stale slug still resolves): `{ id, slug, locale, title, body (Markdown), path, url, locales, publishedAt, updatedAt }`. `404` for a draft, an unpublished or deleted article, or another project's |
| `POST /v1/help/articles/{id}/feedback` | `help:read` | "Was this helpful?": body `{ helpful, locale?, comment? (≤ 500), visitorId? }`; `201 { counted }`, where `counted` is false when the same visitor already answered that article today (the new answer replaces it). `404` as for the article; 30 a minute per client address on top of the key's limit; see [Help center](./help-center.md#was-this-helpful) |
| `POST /v1/messenger/sessions` | `messenger:chat` | A session for a user the app's server signed (`userHash`); then `/v1/messenger/conversations…` with the `mms_` session token; see [Messenger](./messenger.md) |
| `GET /v1/flags/stream` | `flags:read` key, or `?token=` from an OFREP response | OFREP event stream: `refetchEvaluation` events (`id` = version, `Last-Event-ID` resumes), pings every 25 s, closes after 240 s; see [Feature flags](./flags.md#change-stream) |
| `POST /v1/flags/telemetry` | `flags:read` (publishable: client-visible flags only) | Aggregated evaluation counts `{ evaluations: [{ flag, variant, count, windowStart }] }` (≤ 500 entries); `202 { accepted, ignored }`; 300 a minute per key on top of the key's limit; see [Feature flags](./flags.md#evaluation-telemetry-and-stale-flags) |
| `POST /v1/ofrep/v1/evaluate/flags` · `…/flags/{key}` | `flags:read` (publishable: client-visible flags only) | OFREP bulk / single evaluation for `{ context }`; bulk has an `ETag` (`If-None-Match` → `304`) and `eventStreams`; see [Feature flags](./flags.md#ofrep-browsers-and-apps) |
| `GET /v1/flags/ruleset` | secret, `flags:read` | The key's environment as a flagd v0 document, with a strong `ETag` and `Cache-Control: private, no-cache`; `If-None-Match` with the current tag → `304` (the document isn't loaded); see [Feature flags](./flags.md#serving-server-sdks) |
| `GET /v1/runs` | secret, `runs:read` | The runs of the repositories this key's project links, newest first, with the commit that produced each. Filters: `state`, `repoId`, `limit` (≤ 100), `before` (the previous page's last `createdAt`); the answer carries `nextBefore` when the page was full. `Cache-Control: private, no-cache` |
| `POST /v1/monitors/{id}/check` | secret, `status:write` | An ad-hoc round of one of the key's project's monitors, e.g. from a pipeline step after a deploy: a round that isn't due yet is pulled to now, one already due stays. `202 { monitorId, roundAt }`; the verdict follows when the probes report, like any round. `404` for an unknown id or another project's monitor, `409 conflict` for a paused one; 10 a minute per key on top of the key's limit; see [Status: the deploy watch](./status.md#the-deploy-watch) |
| `GET /v1/locations` · `/v1/monitors` · `/v1/monitors/{id}` · `/v1/pages` · `/v1/pages/{id}/components` · `/v1/incidents?pageId=` · `/v1/incidents/{id}` · `/v1/maintenances?pageId=` | secret, `status:read` | The project's status resources as explicit DTOs: a monitor's `target` is its host and port, never its URL's credentials, path or query, its body or its token hash. `404` for another project's page, monitor or incident; see [Status: the /v1 management API](./status.md#the-v1-management-api) |
| `PUT /v1/monitors/by-key/{key}` | secret, `status:write` | Monitors as code: create or change the project's monitor with this key to match the body (the console's monitor input). `201 { outcome: "created", monitor, heartbeatToken }` once, then `200` with `updated`, or `unchanged` (no write, no audit entry) when it already matches; `409` for a switch between a heartbeat and a probe kind |
| `POST /v1/monitors/{id}/pause` · `…/resume` · `DELETE /v1/monitors/{id}` · `PATCH /v1/components/{id}` · `POST /v1/incidents` · `…/{id}/updates` · `PUT /v1/incidents/{id}/components` · `POST /v1/maintenances` · `…/{id}/cancel` | secret, `status:write` | Pause, resume and delete a monitor, set a component's status, open an incident and post its updates, replace its components, schedule and cancel maintenance; `409` for a change the state doesn't allow |
| `POST /v1/status-pages/{slug}/subscribers` | none: the page's slug is public | A visitor signs up for a status page's updates by email, as JSON or a form post: `{ email, componentIds?, locale? ("en", "ko"), website? }`. `202 { status: "pending_confirmation" }` whether the address is new, pending or already subscribed, and when `website` (a honeypot) is filled; a confirmation mail follows. `400` for a bad address or a component not on the page, `404` for an unknown page, `503 subscriptions_unavailable` when the server sends no email. 10 per 10 minutes per client address and 3 an hour per page and address; `Access-Control-Allow-Origin: *`; see [Status: subscribers](./status.md#subscribers) |
| `GET /v1/status-pages/{slug}/subscribers/confirm?token=` · `GET`/`POST …/unsubscribe?token=` | none: the signed token from the mail | The pages the mail's links open (HTML): confirm the sign-up; ask before unsubscribing, then unsubscribe from the form or a one-click `POST` (RFC 8058). An invalid, expired or wrong-purpose token is a `400` page. 30 a minute per client address |
| `GET /v1/status/openapi.json` | none | The OpenAPI 3.1 description of the status routes, generated from their zod schemas |
| `GET` or `POST /v1/ping/{token}` · `…/{token}/start` · `…/{token}/fail` · `…/{token}/{exitCode}` | none: the heartbeat's `mhb_` token in the path is the credential | A [heartbeat monitor](./status.md#heartbeat-monitors)'s job reports that it finished, started, failed, or exited with a code (0 to 255; 0 is a success). `200 OK` (text). A token of the wrong shape, one that matches no heartbeat (unknown, rotated, or its monitor deleted) and an exit code over 255 get the same `404` as a route that doesn't exist (plain text, not problem+json), so a ping can't tell them apart. A body is ignored. 5 every 5 seconds per token (counted before the token is looked up) and 600 a minute per client address; over either, `429 rate_limited` |
| `GET /v1/runs/{id}` | secret, `runs:read` | One run with its steps and gates — enough to say why it is paused and on what. `404` for a run the project does not link, including one in the same workspace |
| `GET /v1/ota/apps/{otaAppId}/manifest` | none (devices) | Expo Updates protocol v1; see [Mocco-hosted OTA](./ota-hosting.md#serving-devices) |
| `GET /v1/ota/apps/{otaAppId}/assets/{hash}` | none (devices) | `302` to the verified asset bytes |
| `POST /v1/ota/apps/{otaAppId}/events` | none (devices; rate-limited per IP) | `202`; body `{ clientId, platform, events: [{ type, updateId, occurredAt?, detail? }] }` (≤ 50 events, ≤ 16 KB; `413` over) |
| `GET /v1/ota/apps/{otaAppId}/releases/{releaseId}` | secret, `ota:write` | `{ id, status, runtimeVersion }` |
| `POST /v1/ota/apps/{otaAppId}/releases/{releaseId}/promotions` | secret, `ota:write` | body `{ channel, rolloutPercent?, reason? }`; `201` applied, `202` approval pending (protected channel), `200` no-op: `{ channel, releaseId, kind, platforms, changed, outcome, requestId }`; `400`/`409` with a `detail` |
| `POST /v1/ota/apps/{otaAppId}/channels/{channel}/pause` · `…/rollback` · `…/rollback-to-embedded` | secret, `ota:write` | `201 { kind, platforms, … }` — never gated; body `{ runtimeVersion?, platform?, reason? }`; `409` with a `detail` when nothing applies |
| `GET /v1/ota/apps/{otaAppId}/promotions/{requestId}` | secret, `ota:write` | `{ requestId, state }` (`pending`, `approved`, `rejected`, `superseded`, `expired`) |
| `POST /v1/ota/auth/oidc` | none (a GitHub Actions OIDC token in the body) | `201 { sessionToken, expiresAt, allowedChannels }`, or a fixed `403` |
| `GET /v1/ota/uploads/{releaseId}` | upload session | `{ id, status, runtimeVersion }` of the session's release |
| `POST /v1/ota/uploads/{releaseId}/promotions` | upload session | like the key route, limited to the session's allowed channels |
| `GET /v1/ota/uploads/{releaseId}/promotions/{requestId}` | upload session | `{ requestId, state }` |
| `POST /v1/ota/apps/{otaAppId}/upload-sessions` | secret, `ota:write` | `201 { sessionToken, expiresAt }`: a 15-minute `mk_ups_` upload session |
| `POST /v1/ota/uploads` | upload session | `201 { releaseId, assetBaseUrl, missing, rollbackTargets }`; see [Mocco-hosted OTA](./ota-hosting.md#uploads-from-ci) |
| `POST /v1/ota/uploads/{releaseId}/finalize` | upload session | `200 { releaseId, status, updates }`, or `400 upload_rejected` whose `detail` says what to fix |

The `/v1/help` reads take `locale` as any language tag (`en-KR` and `en_KR` count as `en`) and answer in that language where the site offers it, else in its source language; `locale` in the answer says which was served (an article not yet translated is served in the source). They carry a weak `ETag` over the answer and `Cache-Control: public, max-age=60`; `If-None-Match` with the current tag → `304`. There is no OpenAPI description for the help routes: this table and the wire types in `@mocco/common/help-v1` (which the SDK is checked against) are the contract. The status routes have one, generated from `@mocco/common/status-v1` and tested against the mounted routes.

Products add their routes to `transport/ext/v1/routes.ts` with `requireKey(deps, { scope })`. New fields are additive only inside `v1`; a breaking change is `/v2`.
