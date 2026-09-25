---
title: ADR Index
description: Chronological index of all architecture decision records with their status and dates.
type: overview
status: active
created: 2026-06-30
updated: 2026-09-25
confidence: high
owner: andrea
tags: [adr, index]
related:
  - ../index.md
---

# ADR Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-name-the-product-mocco.md) | Name the product Mocco | accepted | 2026-06-30 |
| [0002](./0002-mocco-is-an-independent-authorization-layer.md) | Mocco is an independent authorization layer (separate from GitHub, only identifiers sync) | accepted | 2026-06-30 |
| [0003](./0003-core-model-is-pause-resume-gates-no-env.md) | Core model = pause/resume gates, drop env (role-based resume) | accepted | 2026-06-30 |
| [0004](./0004-executor-agnostic-core-with-adapter-contract.md) | Executor-agnostic core + adapter contract (trigger + callback + credentials) | accepted | 2026-06-30 |
| [0005](./0005-tech-stack-vercel-native-next-fullstack.md) | Tech stack = Vercel-native Next full stack (yarn4, Drizzle, Better Auth) | accepted | 2026-07-01 |
| [0006](./0006-domains-mocco-club-prod-mocco-work-local.md) | Domains — prod mocco.club, local mocco.work | accepted | 2026-07-01 |
| [0007](./0007-pglite-testing-and-local-lint-base.md) | pglite for tests, local lint base (amends 0005) | accepted | 2026-07-04 |
| [0008](./0008-vitest-replaces-jest.md) | vitest replaces jest (amends 0005/0007) | accepted | 2026-07-06 |
| [0009](./0009-frontend-uses-the-pages-router.md) | Frontend uses the Pages Router | accepted | 2026-07-11 |
| [0010](./0010-mocco-yml-lean-core-and-enforcement-invariants.md) | `.mocco.yml` stays a lean governance file; enforcement invariants are broker-side | accepted | 2026-07-12 |
| [0011](./0011-external-api-surface-architecture.md) | External API surface — Hono on the App Router | accepted | 2026-07-14 |
| [0012](./0012-repository-per-table-for-db-owning-domains.md) | Repository per table for DB-owning domains | accepted | 2026-07-15 |
| [0013](./0013-mocco-is-a-multi-product-platform.md) | Mocco is a multi-product platform — projects below workspaces, per-workspace product enablement | draft | 2026-09-25 |
| [0014](./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md) | Background jobs on a Postgres job table driven by a tick | draft | 2026-09-25 |
| [0018](./0018-domain-events-vs-audit-log.md) | Domain events are separate from the audit log | draft | 2026-09-25 |
| [0019](./0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md) | Inbound webhooks use per-source ingest URLs with mandatory signatures | draft | 2026-09-25 |
| [0020](./0020-moccos-own-alerts-go-through-mocco-guarded-by-an-external-heartbeat.md) | Mocco's own alerts go through Mocco, guarded by an external stage0 heartbeat | draft | 2026-09-25 |

0015–0017 are reserved for the decisions named in the [platform foundations design](../specs/2026-09-24-platform-foundations-design.md) §21 (public sites, end-user identity, public API) and are written with their slices.

> Add new decisions as `{NNNN}-{imperative-kebab}.md`. Reversals become a new ADR + `superseded_by` on the old one. No after-the-fact edits to the body.
