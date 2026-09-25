---
title: Inbound source adapters (Sentry, Vercel, GitHub) implementation plan
description: Plan for the first notification relay slice of #243 — pure adapters that verify a webhook signature, extract the delivery id, and map a payload to an inbound event type, facts and a sender-agnostic NeutralMessage, with no DB, transport or services.
type: spec
status: active
phase: implementation
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, plan, notifications, inbound, webhooks]
related:
  - ../../reference/backend-conventions.md
  - ../../adr/0011-external-api-surface-architecture.md
---

# Inbound source adapters implementation plan

Part of #243 (notification relay, build step 6). This slice lands only the pure adapters; the ingest
route, `InboundService`, receipts and publishing come in later PRs and call these functions.

## Shared types (`@mocco/common`)

- `@mocco/common/notification`: `Severities`, `NeutralMessageLimits`, `neutralMessageSchema` /
  `NeutralMessage` (title ≤ 256, description ≤ 2000, ≤ 10 fields, optional actor, footer).
- `@mocco/common/inbound`: `InboundKinds`, `InboundEventTypes` (every Sentry, Vercel and GitHub
  type; governance types stay with the domain events slice), `factsSchema` / `Facts`.

## Adapters (`packages/backend/src/domain/inbound/sources/`)

Each of `sentry.ts`, `vercel.ts`, `github.ts` exports:

```ts
verify(rawBody: Uint8Array, headers: Headers, secret: string): boolean
deliveryId(body: string, headers: Headers): string | undefined
parse(body: string, headers: Headers): ParsedInbound
```

The signature is checked over the exact received bytes, as the relay did, so a BOM or any byte the
sender signed is covered. `parse` and `deliveryId` take text produced by
`decodeBody(bytes: Uint8Array): string | undefined` (strict UTF-8, a leading BOM stripped). When it
returns undefined the caller records `IgnoredReasons.invalidUtf8` ("body is not valid UTF-8").
The ingest flow is therefore: `verify(bytes)`, then `decodeBody(bytes)`, then `deliveryId` and
`parse` on the text.

`shared.ts` holds:

- `ParsedInbound` (`{ kind: 'event', type, facts, message }` or `{ kind: 'ignored', reason }`).
- `isValidHmacHex` over bytes: node:crypto `createHmac` + `timingSafeEqual`, accepting only exactly
  the digest's length in hex (case-insensitive).
- `sanitize`: every string in a message, a fact or a reason has NUL removed and lone surrogates
  replaced, so the Postgres text/jsonb writes never fail on a JSON `\u` escape. Reasons are also
  capped at 200 characters.
- `ownValue`: table lookups keyed by payload values (event names, types, levels) read own properties
  only, so `__proto__`, `toString` and similar names are ignored instead of resolving to
  Object.prototype.
- `buildMessage`: truncates every part and drops trailing fields until the message fits Discord's
  6000-character total, so the result always satisfies `neutralMessageSchema` (which enforces the
  per-part limits, a 256-character actor name, and the total).

| Source | Signature | Delivery id | Mapped |
|---|---|---|---|
| Sentry | `Sentry-Hook-Signature`, bare hex HMAC-SHA256 | `Request-ID` header | resource `issue`, action `created` |
| Vercel | `x-vercel-signature`, bare hex HMAC-SHA1 | payload `id` | `deployment.created` / `.succeeded` / `.error` / `.canceled` |
| GitHub | `X-Hub-Signature-256`, `sha256=` + hex HMAC-SHA256 | `X-GitHub-Delivery` header | push, pull_request, issues, release, workflow_run |

The relay's filters become mapping: a Vercel preview success maps to
`vercel.deployment.succeeded` with `target = preview`, and a push without commits maps with
`hasCommits = false`. A push to a branch carries `refType = branch` and `branch`; a tag push carries
`refType = tag` and no `branch`. Workflow runs concluding `failure`, `timed_out` or
`startup_failure` map to `github.workflow_run.failed`. Empty strings fall back like the relay's `||`
(environment `unknown`, target `preview`, project and workflow names). Notification rules decide
later what a channel receives. Messages carry the
relay's text and links; colors and emoji move to the Discord sender, keyed by `severity`.

## Steps

1. Common schemas and constants, plus the export subpaths.
2. Fixtures under `domain/inbound/testdata/`, taken from the relay tests and the vendors' documented
   payload shapes.
3. Failing tests per adapter: signature cases (byte-level, BOM, invalid UTF-8, exact hex length),
   delivery id, each mapped type, ignored reasons, prototype-member names, NUL and lone surrogates,
   empty-string fallbacks, malformed JSON, truncation and the total limit, and
   `neutralMessageSchema.parse` on every message.
4. `shared.ts`, then the three adapters, until the tests pass; `yarn verify` green.

## Open points

- The `refType` fact is not in the design spec's facts table yet; the spec should gain it.

- Sentry's documented issue payload has no environment; `facts.environment` is read when present and
  is `unknown` otherwise.
- Vercel documents `deployment.meta` only as a map; the branch and commit message come from the
  `githubCommitRef` / `githubCommitMessage` keys when present.
