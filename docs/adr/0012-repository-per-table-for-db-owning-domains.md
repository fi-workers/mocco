---
title: Repository per table for DB-owning domains
description: A domain that owns mocco_ tables centralizes its drizzle queries in per-table repository classes (domain/<d>/repos/<t>.repo.ts), constructor-injected; services reach the DB only through repos (lint-enforced) and map the repos' EntityNotFoundError to domain errors. Adopts the fi-workers house repo pattern, adapted to mocco's constructor-injection + pglite rules.
type: adr
status: accepted
created: 2026-07-15
updated: 2026-07-15
confidence: high
owner: andrea
decision_date: 2026-07-15
stakeholders: [andrea]
tags: [adr, backend, domain, data-access, repository, drizzle]
related:
  - ./0007-pglite-testing-and-local-lint-base.md
  - ./0008-vitest-replaces-jest.md
---

# ADR 0012 — Repository per table for DB-owning domains

## Context

`ConnectionService` (the GitHub-integration slice) is the **first domain in the codebase to
own its own `mocco_` tables and access the DB directly** — `auth` is vendor-mediated (every
query goes through better-auth), so it set no precedent for raw data access. As first, its
shape becomes the template every future governance domain copies. It initially embedded
drizzle queries inline across its service methods, mixing data access with policy.

The fi-workers house style (showyourtime, checkable) already answers "how does a service
touch the DB": a **repository per table**, `<domain>/repos/<table>.repo.ts`, with `find*`
(returns rows, never throws) / `get*` (single row, throws `EntityNotFoundError`) naming, the
repo throwing a shared DB-layer error and the service mapping it to a domain error. That
house pattern uses `static` methods over a module-singleton `db`, which mocco forbids
(AGENTS.md: no static classes importing singletons; per-test pglite requires an injected db;
`vi.mock` is banned, ADR 0008).

## Decision

A domain that owns `mocco_` tables centralizes **all** its drizzle queries in per-table
repository classes under `domain/<d>/repos/<table>.repo.ts`. Adopt the house conventions —
`find*`/`get*` naming, repo throws `EntityNotFoundError` (`infra/db/errors.ts`), service
catches and maps to its domain error — but **instance classes constructed with `db`**
(`new ProviderConnectionRepo(db)`), not static + singleton, to preserve mocco's
constructor-injection seam and pglite-per-test isolation.

- Repos are the **sole importers of `drizzle-orm` / the db schema** within the domain
  (lint-enforced: `no-restricted-imports` bans both in `domain/**/*Service.ts`).
- The **tenant-isolation invariant lives in the repos**: every read/update is scoped by
  `workspaceId` in its `WHERE` clause.
- The service is the **policy layer**: it maps `EntityNotFoundError` → domain errors
  (`ProviderConnectionNotFoundError`, `RepoNotFoundError`), owns domain constants, and calls
  the provider. This reinforces the existing rule that DB/vendor error shapes become domain
  errors *at the service* (AGENTS.md).
- Shared single-row helpers live in `infra/db/rows.ts`: `getOrThrow` (lookup that may miss →
  `EntityNotFoundError`) and `expectOne` (single-row write guaranteed to return one → plain
  invariant `Error`, not a not-found).
- Scope: DB-owning domains only. `auth` is exempt (vendor-mediated, owns no `mocco_` tables
  directly).

## Consequences

- New governance domains follow the same shape by construction; the lint rule keeps a service
  from regressing to inline drizzle.
- One extra indirection (service → repo) per data access, and per-table repo files. Accepted:
  it buys a single place to reason about a domain's persistence and keeps the tenant-scoping
  at the data boundary.
- Tests stay on pglite through the service (no fake repo) — coverage unchanged; the repos are
  exercised transitively.
