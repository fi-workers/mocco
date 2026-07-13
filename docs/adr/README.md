---
title: ADR Index
description: Chronological index of all architecture decision records with their status and dates.
type: overview
status: active
created: 2026-06-30
updated: 2026-06-30
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

> Add new decisions as `{NNNN}-{imperative-kebab}.md`. Reversals become a new ADR + `superseded_by` on the old one. No after-the-fact edits to the body.
- [0007 — pglite for tests, local lint base (amends 0005)](./0007-pglite-testing-and-local-lint-base.md)
- [0008 — vitest replaces jest (amends 0005/0007)](./0008-vitest-replaces-jest.md)
