---
title: Public /v1 API, publishable and secret keys, and MIT SDKs
description: Customers and SDKs call a versioned /v1 surface on the Hono ext app with project-scoped publishable (mk_pub_) or secret (mk_sec_) keys stored as hashes, rate-limited by a Postgres fixed-window limiter, answering RFC 9457 problem+json; SDK packages are MIT while the server stays AGPL.
type: adr
status: draft
created: 2026-10-01
updated: 2026-10-01
confidence: high
owner: andrea
decision_date: 2026-10-01
stakeholders: [andrea]
tags: [adr, platform, api, api-keys, rate-limiting, sdk, licensing]
related:
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./0011-external-api-surface-architecture.md
  - ../reference/public-api.md
---

# ADR 0017 — Public /v1 API, publishable and secret keys, and MIT SDKs

## Context

Feature flags need a ruleset endpoint, OTA hosting needs uploads and update checks, and later products (feedback, messenger, links) need public endpoints that customers' apps and servers call. Some callers are customer servers that can hold a secret; others are browsers and React Native apps that can't. Tenant isolation must not depend on the caller being honest, and abuse must be bounded without a separate service, because self-hosting is Node and Postgres only.

## Decision

1. **One versioned surface: `/v1` on the Hono ext app** (ADR 0011), mounted at `/api/ext/v1`. With `PUBLIC_API_DOMAIN` set, `https://<that host>/v1/*` rewrites to it. Changes inside `v1` are additive only; a breaking change is `/v2`. tRPC stays internal.
2. **Two key kinds, scoped to a project:**
   - **Publishable** (`mk_pub_…`) keys are safe to embed in web and React Native apps and grant only client scopes. A request that carries an `Origin` must come from one of the project's apps' `web_origins`; native apps send no origin and are bounded by rate limits.
   - **Secret** (`mk_sec_…`) keys are for servers and may hold any scope. A request with an `Origin` header is refused, so a secret key pasted into a web page stops working instead of leaking quietly.
3. **Keys are stored as hashes.** The token is shown once at creation. The database keeps its SHA-256 (unique), its kind, its last four characters, its scopes, and its expiry and revocation times. Authentication is a hash lookup. Creating and revoking a key is audited (`apikey.created`, `apikey.revoked`), and both are owner/admin-only.
4. **Rate limiting through a `RateLimiter` port.** The default `postgres` driver is a fixed-window counter (`mocco_rate_limit_counters`, one `INSERT … ON CONFLICT DO UPDATE … RETURNING` per request, pruned hourly). A `memory` driver serves tests, and a Redis driver can be added for high volume. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. Hot, cacheable reads (flag rulesets, OTA manifests, version checks) are served from the CDN and limited at the edge, not per request in Postgres.
5. **Errors are RFC 9457 `application/problem+json`** with a stable `type` (`https://mocco.dev/problems/<code>`), a `title` and a `status`. They never carry vendor or SQL detail.
6. **SDK packages are MIT; the server stays AGPL-3.0.** An AGPL client library inside a customer's app would block adoption. Each published SDK package carries its own `LICENSE`.

## Consequences

- Every product endpoint reuses one `requireKey({ kind, scope })` middleware and gets tenant scoping from the key, never from the request body.
- Publishable keys are not secret. Their protection is the origin check, client-only scopes, rate limits and, for writes, an end-user session (added with the identity layer).
- A leaked secret key works until it is revoked. The UI shows when each key was last used, and CI publishing prefers the OIDC credential broker over long-lived keys.
- The Postgres limiter costs one write per limited request, which is acceptable for writes and auth-sensitive endpoints, and is why hot reads are edge-cached.
