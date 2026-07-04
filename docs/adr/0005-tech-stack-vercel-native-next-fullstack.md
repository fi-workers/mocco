---
title: Tech stack — Vercel-native Next full stack (house alignment)
type: adr
status: accepted
created: 2026-07-01
updated: 2026-07-01
confidence: high
owner: andrea
decision_date: 2026-07-01
stakeholders: [andrea]
tags: [adr, stack, architecture, vercel, next]
related:
  - ./0004-executor-agnostic-core-with-adapter-contract.md
  - ../reference/mocco-yml-spec.md
---

# ADR 0005 — Tech stack: Vercel-native Next full stack

## Context

With planning and the prototype done, we're deciding the actual implementation stack. Constraints and goals:
- **Single Vercel deployment** (owner requirement) — no desire to run two servers.
- **House alignment**: ShowYourTime and Checkable are all Next 16 + yarn workspaces + `@fi-workers/eslint-config` + Better Auth + reusable CI. Avoid the cost of re-setup.
- Mocco is an **internal dashboard behind login** → no SSR/SEO needed. The reason to adopt Next is not SSR but **ecosystem consistency + single deployment**.
- The workload is mostly **event-driven** (webhooks) + a bit of scheduling.

## Decision

**Deploy a single Next 16 full stack to Vercel.** No separate backend server or always-on worker.

| Layer | Choice | Notes |
|---|---|---|
| Deployment | **Single Vercel** | No Fly/Railway needed |
| App | **Next 16** (web + tRPC route handlers + webhook/verify/broker handlers) | Serverless functions |
| API | **tRPC 11** on Next route handlers | No separate API server |
| DB | **Postgres (Neon/Supabase)** + **Drizzle** | Serverless Postgres |
| Async | **Vercel Cron + Postgres job/outbox table** | Upgrade to Inngest if needed |
| Auth | **Better Auth** | Also fits the independent-auth model (ADR 0002) |
| Monorepo | **yarn 4 workspaces** (`src/*`, `@mocco/*`) | Same as house |
| Lint | **`@fi-workers/eslint-config`** + ts-check | husky pre-commit |
| Test | **Jest + ts-jest**, DB via docker-compose Postgres | Same as house (Checkable) |
| CI | **reusable workflows** (lint/test/build), paths-filter | Copied from house |
| Verify Action | Separate package `@mocco/verify-action` (JS action, Marketplace) | Adapter artifact |

### Why Hono, pg-boss, and Fly were dropped (reversing an earlier review)

- **Separate Hono server ❌** → Next route handlers. Single Vercel deployment + the house backend is also Next. No need to build API handlers separately.
- **pg-boss ❌** → serverless can't run an always-on worker. Mocco is event-driven, so webhook handlers + **Vercel Cron + a Postgres job table** are enough.
- **Fly/Railway ❌** → Vercel alone covers it.

## Monorepo structure (3-way split + mount)

```
src/
  frontend/   @mocco/frontend — Next UI. app/api/* only mounts the backend (thin)
  backend/    @mocco/backend — server logic (domain FSM/executor, db, tRPC, jobs, webhook/verify/cron handlers)
  common/     @mocco/common — shared (zod .mocco.yml, shared types like RunState)
_later/verify-action/  — GitHub Action (different deploy model). Separate repo later
```

> The draft had 5 packages (web/core/db/common/verify-action), but that was over-split, so it was consolidated to 3 packages + a backend mount pattern (2026-07-01).

## Consequences

- One language (TS) unifies web, API, Verify Action, and domain.
- Serverless constraint: no long-running work → forces an event + cron design (cleaner, if anything).
- `@fi-workers/eslint-config` must be published/linked (install step).
- Keep the actual code in `src/` and the prototype in `prototype/` separate (AGENTS.md).

## Reversal Conditions

- If durable multi-step orchestration (long retries, sagas) grows, adopt **Inngest** (still serverless, stays on Vercel).
- If a truly always-on worker becomes necessary, split just that part off to Fly (web/API stay on Vercel).
