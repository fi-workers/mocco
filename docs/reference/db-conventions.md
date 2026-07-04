---
title: DB conventions (Drizzle)
type: reference
status: active
created: 2026-07-01
updated: 2026-07-01
confidence: high
owner: andrea
code_refs: [src/backend/db/schema.ts]
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
  - Exception: `mocco_audit_log` uses a `bigserial seq` PK (for append-only monotonic ordering).
- **Index names: `mocco_<table>_<col>_idx`** (e.g., `mocco_runs_state_idx`).
- **Table export names: plural lowercase** (`runs`, `roles`) — convenient for drizzle relational queries.

## Migrations

- `yarn db:generate` → `src/backend/db/migrations/*.sql` (+ meta), **git-tracked**.
- `yarn db:migrate` → apply. Local uses docker Postgres (`make docker-up`).
- Schema change = generate + migrate. Reset with `docker compose down -v`.

## Better Auth

When wiring Better Auth, set the tables to the **`mocco_` prefix** (`user`→`mocco_users`, etc.). Use the Drizzle adapter's modelName/tableName mapping, or Better Auth's `tablePrefix`/schema config. They coexist in one DB with the domain tables, distinguished by the prefix.
