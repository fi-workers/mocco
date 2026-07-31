---
title: DB conventions (Drizzle)
description: Drizzle and Postgres schema conventions — mocco_ table prefix, snake_case columns, uuid primary keys, timestamp helpers, and index naming.
type: reference
status: active
created: 2026-07-01
updated: 2026-07-01
confidence: high
owner: andrea
code_refs: [packages/backend/src/infra/db/schema.ts]
tags: [reference, db, drizzle, conventions]
related:
  - ../adr/0005-tech-stack-vercel-native-next-fullstack.md
---

# DB conventions (Drizzle)

Ported from the house pattern (showyourtime's `syt_`).

## Rules

- **Table prefix `mocco_`** — all tables. Better Auth tables are also configured with the `mocco_` prefix (below).
- **Columns: snake_case** (`created_at`, `repo_id`) — specify drizzle column names explicitly.
- **Common column helpers** (top of `schema.ts`):
  - `createdAt = timestamp('created_at').notNull().defaultNow()`
  - `updatedAt = timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date())`
- **id: `uuid().primaryKey().defaultRandom()`** — non-sequential (guards against token/audit/URL exposure). *The house uses integer identity, but Mocco uses uuid given its token/audit nature.*
  - Exception: `mocco_audit_log` (governance phase) uses a `bigserial seq` PK (for append-only monotonic ordering).
- **Index names**: `mocco_<table>_<col>_idx`; unique indexes use `mocco_<table>_<cols>_uq` (e.g. `mocco_members_workspace_user_uq`). Historical exception: `mocco_accounts_provider_account_idx` is unique but `_idx`-named — left as-is to avoid migration churn.
- **Table export names: plural lowercase** (`runs`, `roles`) — convenient for drizzle relational queries.

## Advisory locks

A read-then-write that must stay consistent under concurrency needs a DB-level lock, not an
in-process one: `client.ts` caps each serverless instance at one connection, so the contention is
between separate lambdas and only Postgres can arbitrate it.

- **Always `pg_advisory_xact_lock`, inside a transaction** — never the session-level
  `pg_advisory_lock`. Production points `DATABASE_URL` at Supabase's transaction pooler, where a
  connection is not sticky across statements, so a session lock can be taken on one backend and
  released on another (or leak). A transaction-scoped lock releases on commit *or* rollback.
- **Take the namespace from `AdvisoryLockNamespaces`** (`infra/db/advisory-locks.ts`), never an
  inline integer. Advisory locks share one keyspace per cluster; the two-argument form
  (`pg_advisory_xact_lock(<namespace>, hashtext(<uuid>))`) keeps unrelated features from blocking
  each other. Register new namespaces there.
- **Own it in the repo, not the service** (ADR 0012) — the repo runs the transaction and calls back
  into the domain for anything pure it needs (see `AuditRepo.appendChained`, which asks the caller
  for the hash once the predecessor is known).

## Migrations

- `yarn db:generate` → `packages/backend/src/infra/db/migrations/*.sql` (+ meta), **git-tracked**.
- `yarn db:migrate` → apply. Local uses docker Postgres (`make docker-up`).
- Schema change = generate + migrate. Reset with `docker compose down -v`.

## Better Auth

When wiring Better Auth, set the tables to the **`mocco_` prefix** (`user`→`mocco_users`, etc.). Use the Drizzle adapter's modelName/tableName mapping, or Better Auth's `tablePrefix`/schema config. They coexist in one DB with the domain tables, distinguished by the prefix.
