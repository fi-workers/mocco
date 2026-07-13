---
title: "ADR 0007: pglite for tests, local lint base (amends 0005)"
description: Adopts pglite for docker-free Postgres tests and sets a local lint base, amending the ADR 0005 stack.
type: adr
status: accepted
created: 2026-07-04
updated: 2026-07-04
confidence: high
owner: andrea
tags: [adr, testing, pglite, eslint, stack]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
---

# ADR 0007: pglite for tests, local lint base (amends 0005)

## Status

Accepted. Amends [ADR 0005](./0005-tech-stack-vercel-native-next-fullstack.md) — 0005's body stays immutable; this records where implementation diverged from it.

## Context

Building the foundation slices surfaced better options than 0005 planned, and two 0005 items haven't been needed yet.

## Decision

1. **Tests run on pglite, not docker-compose Postgres.** Integration tests boot an in-memory WASM Postgres (`@electric-sql/pglite`) per test and apply the real migrations (`src/backend/db/testing/pglite.ts`). Docker remains only for the local dev server's persistent DB. Rationale: zero-setup contributor onboarding, full isolation per test, and CI needs no service containers.
2. **Lint config is a local base, not a published package.** `eslint.config.base.mjs` in-repo (built on `eslint-config-airbnb-extended` + typescript-eslint strict + unicorn + sonarjs) instead of a published `@fi-workers/eslint-config`. Rationale: the config evolves with the repo (rules are promoted from review feedback); publishing would add release friction for no consumer beyond this repo.
3. **tRPC and `@mocco/common` are deferred, not abandoned.** The API layer lands when the first real domain API is needed (governance phase); `common` returns when shared domain types exist. Until then, docs referring to them describe the plan, not the repo.

## Consequences

- 0005's rows for test-DB, lint packaging, tRPC, and `common` describe superseded or not-yet-landed plans; this ADR is the current truth.
- If a future consumer outside this repo needs the lint config, revisit publishing.
- Path note: the click-through prototype lives under `docs/prototype/` (0005 wrote `prototype/`; it moved when the repo went public).
