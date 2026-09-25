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
verify(rawBody: string, headers: Headers, secret: string): boolean
deliveryId(rawBody: string, headers: Headers): string | undefined
parse(rawBody: string, headers: Headers): ParsedInbound
```

`shared.ts` holds `ParsedInbound` (`{ kind: 'event', type, facts, message }` or
`{ kind: 'ignored', reason }`), the constant-time `isValidHmacHex` (node:crypto `createHmac` +
`timingSafeEqual`, length-checked), safe JSON parsing, and `buildMessage`, which truncates every part
so the result always satisfies `neutralMessageSchema`.

| Source | Signature | Delivery id | Mapped |
|---|---|---|---|
| Sentry | `Sentry-Hook-Signature`, bare hex HMAC-SHA256 | `Request-ID` header | resource `issue`, action `created` |
| Vercel | `x-vercel-signature`, bare hex HMAC-SHA1 | payload `id` | `deployment.created` / `.succeeded` / `.error` / `.canceled` |
| GitHub | `X-Hub-Signature-256`, `sha256=` + hex HMAC-SHA256 | `X-GitHub-Delivery` header | push, pull_request, issues, release, workflow_run |

The relay's filters become mapping: a Vercel preview success maps to
`vercel.deployment.succeeded` with `target = preview`, and a push without commits maps with
`hasCommits = false`. Notification rules decide later what a channel receives. Messages carry the
relay's text and links; colors and emoji move to the Discord sender, keyed by `severity`.

## Steps

1. Common schemas and constants, plus the export subpaths.
2. Fixtures under `domain/inbound/testdata/`, taken from the relay tests and the vendors' documented
   payload shapes.
3. Failing tests per adapter: signature cases, delivery id, each mapped type, ignored reasons,
   malformed JSON, truncation, `neutralMessageSchema.parse` on every message.
4. `shared.ts`, then the three adapters, until the tests pass; `yarn verify` green.

## Open points

- Sentry's documented issue payload has no environment; `facts.environment` is read when present and
  is `unknown` otherwise.
- Vercel documents `deployment.meta` only as a map; the branch and commit message come from the
  `githubCommitRef` / `githubCommitMessage` keys when present.
