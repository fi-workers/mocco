---
title: Public /v1 API
description: The versioned public API on the ext app — publishable and secret project keys, how requests are authenticated and limited, CORS, problem+json errors, the API host rewrite, and how product routes plug in.
type: reference
status: active
created: 2026-10-01
updated: 2026-10-01
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
---

# Public /v1 API

> Decided in [ADR 0017](../adr/0017-public-v1-api-keys-and-sdk-licensing.md). Customer servers, apps and SDKs call `/api/ext/v1/*`, or `https://<PUBLIC_API_DOMAIN>/v1/*` when that host is configured. tRPC stays internal.

## Keys

A key belongs to one project and has a kind:

| Kind | Token | Where it lives | Scopes |
|---|---|---|---|
| Publishable | `mk_pub_` + 32 base62 characters | Web and React Native apps | Client scopes only: `ota:read`, `flags:read` |
| Secret | `mk_sec_` + 32 base62 characters | Servers and CI | Any scope |

The token is returned once, by `apiKey.create`, and only its SHA-256 is stored; the console shows `mk_sec_…abcd`. Keys are managed on the project's **API keys** tab (`/workspaces/{id}/p/{projectId}/api-keys`): pick the kind (publishable keys offer only client scopes), name it and choose scopes, copy the token from the one-time notice, and revoke with an inline confirmation. Owners and admins create and revoke keys (`apikey.created`, `apikey.revoked` in the audit log); members can list them. A key may expire (`expiresAt`), and its `lastUsedAt` is updated at most once a minute.

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

Per key: 600 requests a minute for publishable keys and 1,200 for secret keys. Per client IP (hashed) and route, for routes without a key: 120 a minute. Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds). Over the limit, the answer is `429 rate_limited` with `Retry-After`.

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

Products add their routes to `transport/ext/v1/routes.ts` with `requireKey(deps, { scope })`. New fields are additive only inside `v1`; a breaking change is `/v2`.
