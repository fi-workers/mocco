---
title: External API surface — Hono on the App Router
description: External inbound (GitHub setup callback, webhooks) is served by a Hono app mounted under the Next App Router, distinct from the internal tRPC (Pages Router) surface. Fixes the raw-body/HMAC pitfall of a Pages-Router mount; supersedes the roadmap's Pages-Router ext mount and records the local webhook-tunnel host.
type: adr
status: accepted
created: 2026-07-14
updated: 2026-07-14
confidence: high
owner: andrea
decision_date: 2026-07-14
stakeholders: [andrea]
tags: [adr, transport, api, hono, webhooks, github]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ./0006-domains-mocco-club-prod-mocco-work-local.md
  - ./0009-frontend-uses-the-pages-router.md
---

# ADR 0011 — External API surface: Hono on the App Router

## Context

Slice 3 (GitHub integration) introduces the first **external inbound** HTTP surface: a GitHub App **setup callback** (a browser redirect, slice 3a) and, next, **webhooks** (server-to-server POSTs, slice 3b). AGENTS.md already fixes the rule that external inbound gets its own REST surface — never tRPC (which is the internal frontend↔backend contract). This ADR pins **how and where** that REST surface is mounted.

Two constraints force the decision:

- **Raw body for HMAC.** GitHub signs the raw webhook body (`X-Hub-Signature-256`, HMAC-SHA256). Any JSON body-parser that reads/re-serializes the body first breaks verification. Next's **Pages Router** API routes run the built-in `bodyParser` (and disabling it per-route is fragile for a catch-all). The **App Router** hands route handlers the untouched fetch-standard `Request`, so `await req.text()` yields the exact signed bytes.
- **Fetch-standard handlers already exist.** The backend exposes `Request → Response` handlers (`AuthService.handler`, `createTrpcHandler`); `hono/vercel` `handle()` likewise targets App-Router `Request`/`Response` handlers. Mounting Hono under a Pages catch-all would hit the very bodyParser we must avoid.

ADR 0009 ("frontend uses the Pages Router") governs **frontend rendering strategy** (SSG landing + CSR app). It does not govern backend route handlers. Next 16 runs the App Router and Pages Router **side by side**, so introducing an `app/` directory for API handlers does not disturb the Pages-Router UI.

## Decision

- **External inbound is a [Hono](https://hono.dev) app** mounted under the Next **App Router** at `packages/frontend/src/app/api/ext/[[...route]]/route.ts` via `hono/vercel` `handle()`. This is the first file under `app/`; the Pages-Router UI is unchanged.
- **Internal frontend↔backend stays tRPC on the Pages Router** (`pages/api/trpc/[trpc].ts`). The vendor auth surface stays on its Pages route.
- **Concrete paths** (pinned, same in prod and local):
  - setup callback — `GET /api/ext/github/setup`
  - webhook (slice 3b) — `POST /api/ext/github/webhook`
- The Hono app lives behind the backend's vendor boundary (`packages/backend/src/transport/ext/app.ts`, exported as `@mocco/backend/ext/app`); `hono` is imported only in that leaf.

## Consequences

- **Supersedes** the E2b roadmap §8, which mounted the ext surface at a Pages route (`pages/api/ext/[[...route]].ts`, `bodyParser:false`), and resolves roadmap §10 open-question 3.
- **Reconciles** ADR 0006's `/api/webhooks/github` and the roadmap's `/api/ext/webhooks/github`: the canonical path is `/api/ext/github/webhook`.
- **Local webhook tunnel host = `hooks.mocco.club`** (slice 3b), a recorded **exception** to ADR 0006's `mocco.work = local` split. Reason: `mocco.work` is not on public DNS, whereas `mocco.club` is already on Cloudflare — a named cloudflared tunnel to a `mocco.club` subdomain is the lower-friction, first-party path. The `mocco.work` local browsing origin (mkcert/traefik) is unaffected.
- Slice 3a's setup callback needs no tunnel (a browser redirect resolves to `localhost` locally); only slice 3b's server-to-server webhook needs the tunnel.

## Reversal conditions

- If a future Next version regresses App/Pages coexistence, or if the ext surface must move off Vercel, re-mount the Hono app on whatever fetch-standard host is available (the Hono app itself is host-agnostic).
