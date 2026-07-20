---
title: Backend conventions (domain / infra / transport)
description: How packages/backend is written — layering and dependency direction, vendor isolation, constructor-injected services, domain errors mapped to transport codes per router, and the lint-enforced house rules.
type: reference
status: active
created: 2026-07-13
updated: 2026-07-20
confidence: high
owner: andrea
tags: [reference, backend, trpc, architecture, errors, lint]
---

# Backend conventions (domain / infra / transport)

`packages/backend` is a layered TypeScript backend behind a tRPC surface. AGENTS.md carries the terse rules; this page is the depth + rationale + examples. When a rule changes, update both — AGENTS.md stays the one-line summary, this page the explanation.

## Layering

`packages/backend/src/` is three layers with a one-way dependency direction — **`transport → domain → infra`**:

- **`domain/`** — Mocco's business logic. One folder per domain (`auth/`, `pipeline/`, and each governance domain as its slice lands). A domain gets its folder when its slice lands — don't pre-create empty ones. `governance/`-style sub-grouping is added only once `domain/` is genuinely crowded.
- **`infra/`** — replaceable plumbing with no business meaning (`db/`, `config/`).
- **`transport/`** — the edges: `trpc/` (internal, Pages Router) and `ext/` (external inbound REST, a Hono app on the App Router — [ADR 0011](../adr/0011-external-api-surface-architecture.md); the only `hono` importer). A transport carries **no business logic** — it parses at the boundary (zod from `@mocco/common`) and delegates to a domain service, so logic is never duplicated across surfaces. External inbound (webhooks, OAuth/setup callbacks) never uses tRPC.

A domain that owns its **own** `mocco_` tables (e.g. `integration`) takes an injected `db` typed as the broad `PgDatabase<PgQueryResultHKT, typeof schema>` (both the prod node-postgres db and the pglite test db satisfy it — the concrete `Db` from `infra/db/client.ts` is node-postgres-only). Vendor SDKs still stay isolated at a leaf even when a port exists (`domain/integration/github/provider.ts` is the sole `@octokit/app` importer, mirroring `domain/auth/provider.ts`) — placing the leaf in `infra` would invert the one-way `domain → infra` rule.

The `@mocco/backend` export subpaths (`./auth/instance`, `./trpc/root`) are the stable public contract — repoint their targets on a move, don't rename the subpaths.

## Vendor isolation

Third-party services are wrapped behind neutral surfaces, so a vendor swap is a single-file rewrite. Only the **leaf boundary file** may import the vendor:

- `domain/auth/provider.ts` is the only file that imports the auth library (better-auth); everything else consumes the neutral services (`AuthService`, `WorkspaceService`).
- When the service must interpret a vendor error, it does so at that boundary — and if it needs a vendor helper for that (e.g. `isAPIError`), the boundary file **re-exports** it so the service stays vendor-clean.

Env var names are ours (`AUTH_SECRET`), never vendor-branded.

## Services & dependency injection

Services are **constructor-injected classes** — `new AuthService(provider)`, `new WorkspaceService(provider)`. A composition root (`auth/instance.ts`) binds them once; tests construct the same classes over pglite.

- **No test-only code in production modules**: no `*ForTesting` hooks, seams, or swappable singletons. Explicit constructor arguments _are_ the seam. Hoisted module-mocking (`vi.mock`) is not a substitute (ADR 0008). If a test can't reach something, fix the design (inject the dependency), don't add a seam.

## Domain errors → transport codes

Vendor/DB failures become **domain errors at the service**; the **transport maps them to codes, per router**. The transport core (`trpc.ts`) never learns any specific domain's errors.

1. **Interpret at the service.** The service that owns the vendor boundary reads the vendor/DB error shape (status codes, messages, pg constraint names) and throws a domain error class **colocated in that domain's `errors.ts`**, carrying the original as `cause`. Never sniff vendor error strings anywhere else.

   ```ts
   // domain/auth/WorkspaceService.ts
   catch (error) {
     if (isAPIError(error)) {
       throw new WorkspaceNotFoundError(workspaceId, { cause: error });
     }
     throw error; // a genuine internal error propagates untouched
   }
   ```

2. **Extend a shared base.** Specific classes extend a base in `domain/errors.ts`, so one `instanceof` covers a whole family:

   ```ts
   // domain/errors.ts
   export abstract class NotFoundError extends Error {}
   // domain/auth/errors.ts
   export class WorkspaceNotFoundError extends NotFoundError { /* … */ }
   ```

3. **Map per router, not centrally.** Each router declares a **router-scoped middleware** composed onto `protectedProcedure` and reuses it across its procedures. A single central middleware would accumulate every domain's mapping over time and couple the transport core to all domains; keeping the mapping with the router that raises the error keeps `trpc.ts` generic and ownership obvious.

   ```ts
   // transport/trpc/routers/workspace.ts
   const protectedWorkspaceProcedure = protectedProcedure.use(async ({ next }) => {
     const result = await next();
     if (!result.ok && result.error.cause instanceof NotFoundError) {
       throw new TRPCError({ code: 'NOT_FOUND', message: result.error.cause.message, cause: result.error.cause });
     }
     return result;
   });
   ```

   Name the composed procedure for its auth level (`protectedWorkspaceProcedure`), so a later public procedure in the same router can't be confused with it. The `errorFormatter` only masks `INTERNAL_SERVER_ERROR`, so a remapped `NOT_FOUND` keeps its message.

## Webhook / external inbound

The GitHub App webhook (`POST /api/ext/github/webhook`, [ADR 0011](../adr/0011-external-api-surface-architecture.md)) follows a **verify-first, ack-fast, sync-deferred** shape:

1. **Verify the HMAC on the raw body first.** The request body is read as raw text and checked against `x-hub-signature-256` before anything else touches it — no write happens on an invalid/absent signature (`401`, generic body, no detail).
2. **Record an idempotent delivery.** `WebhookDeliveryRepo.recordIfNew(provider, x-github-delivery, eventType)` is a DB-unique write keyed on GitHub's own delivery id. A redelivery of the same id is a no-op (`202 duplicate delivery`) — this is the sole dedupe mechanism (no separate job/queue table).
3. **Return `202` immediately**, then run **parse + `CommitSyncService.handle()` in a deferred `@vercel/functions waitUntil` pass**. Parsing is deferred (not done before the `202`) on purpose: GitHub's ~10s delivery budget must never be spent on our work, and — more importantly — a signature-valid but schema-invalid payload must never throw on the request path. If it did, the `500` would tell GitHub to retry, but `recordIfNew` already marked the delivery seen, so the retry would dedup to `202` and the event would be silently dropped forever. Deferring the parse means a bad payload instead yields `202` + a logged error — an intentional, visible, at-most-once drop, not a silent one.
4. **Resolve tenancy via `installation_id → connection → repo by (connection_id, external_repo_id)` — never by `external_repo_id` alone.** A push carries only a global GitHub installation id and a provider repo id, neither workspace-scoped; two workspaces can legitimately watch the same external repo. The connection is looked up first (`findByExternalAccount(provider, installationId)`), then the repo is looked up scoped to that connection's id. Anything that doesn't resolve at any step (unconnected installation, unregistered repo, unclaimed install) is **parked** — logged and dropped, never thrown — since webhooks are fire-and-forget.
5. **Error hygiene to GitHub**: the ext app's `onError` handler (symmetric with the tRPC `errorFormatter`) returns a fixed generic `500` body on any unexpected throw — never a vendor/SQL/token detail. Expected failures (invalid signature, missing delivery id, unconfigured secret) return their own specific status with a generic message; nothing internal leaks either path.

## Config snapshot (`.mocco.yml` per commit)

After `CommitSyncService` records a push's commits, the same deferred `waitUntil` pass snapshots each new commit's `.mocco.yml` — the fetch/parse/store never happens on the webhook request path, same rationale as the sync itself.

1. **Fetch at the commit SHA.** `CommitSource.getConfigAtCommit(ref, sha)` reads the file at that exact tree; a `404` (no `.mocco.yml` in that commit's tree) resolves to `null` — never an error. `null` is a legitimate, expected outcome, not a fetch failure.
2. **Parse with the existing parser.** A `null` fetch stores an explicit absent marker (`present: false`, empty `rawYaml`, no parsed config); a fetched file is parsed by the same `MoccoConfigParser` slice 1 built for `pipeline.preview` (`@mocco/common/mocco-config` remains the single type source) — no second parser.
3. **Snapshot 1:1 into `mocco_commit_configs`.** One row per commit (`commitId` unique), storing `present` / `rawYaml` / `parsedJson` / `valid` / `validationErrors` exactly as parsed. This snapshot **is** the audit-grade record — it is parsed once, at sync time, from the tree as it stood at that SHA, and is never re-derived later from a live fetch.
4. **Best-effort, per commit.** `CommitConfigService.snapshotCommit` catches and logs any failure (fetch, parse, or upsert) for that one commit; `snapshotForCommits` runs a batch concurrently, so one bad commit never blocks or drops another's snapshot, and never sinks the commit-sync pass that already wrote the commit rows. The per-commit fetch is also throttled by the octokit plugin underneath the real `CommitSource` — a known, deferred cost, not yet optimized (e.g. a webhook redelivery re-snapshots already-synced commits, wastefully but idempotently, since the upsert overwrites the same row).

The commit-detail read (`integration.commitDetail`) is a **pure DB read** — `CommitConfigService.getDetail` joins the workspace-scoped commit with its snapshot (if any) and returns the wire shape; no fetch or parse happens on this path. It narrows through `.output(commitDetailSchema)` alone (no hand-projection, per the egress rule above). Two states are distinct in the result: `config: null` means the commit has never been snapshotted yet, while a snapshotted commit always yields a `CommitConfigDto` whose `present: false` means "no `.mocco.yml` at that SHA" — absent-but-checked, not unchecked.

## Workspace-scoped authorization

A procedure that takes a `workspaceId` (or any tenant id) in its **input** must **authorize the caller against it**, not merely filter queries by it. Scoping a DB query by a client-supplied `workspaceId` is _not_ isolation — a non-member who knows the id would otherwise read and write another tenant's data. Filtering and authorizing are two different halves:

- The **repo filters** by `workspaceId` (defence in depth); the **router proves** the caller belongs to it (the actual gate).
- Authorize in the router's workspace-scoped middleware via `WorkspaceService.assertMember(headers, workspaceId)` — it throws `WorkspaceNotFoundError` (→ `NOT_FOUND`, so a non-member can't even learn the workspace exists) and runs **before** any resolver touches the id. Read the id from the raw input (`getRawInput()`), since middleware runs before input parsing.
- Vendor-mediated domains (workspace via better-auth) get this for free — the org plugin authorizes by the session cookie. A domain that owns its own `mocco_` tables and takes `workspaceId` as input (e.g. `integration`) must call `assertMember` explicitly.

This can't be statically lint-enforced, so it is covered by **cross-tenant tests**: a non-member passing the victim's `workspaceId` must be rejected on every procedure (read, write, and install).

## Types & schemas

- **Derive types from values** (has-a, not is-a): prefer `z.infer` / `ReturnType<typeof factory>` over hand-maintained parallel interfaces. Write explicit annotations only where they pin a boundary (e.g. a neutral return type that stops vendor inference from leaking).
- **Repos return the whole row (the model), not a hand-narrowed shape.** A repository maps a table to its entity and returns it in full (`.returning()` / `.select()` with no column projection) — the same rule as "services return raw vendor rows," applied at the DB layer. Don't build `{ someField: row.someField }` inside a repo; that narrowing belongs at the egress boundary, not the data layer.
- **Egress is where narrowing happens — and it must be a _runtime_ narrowing, not a type annotation.** The DTO the caller sees is produced at the boundary:
  - **tRPC procedures**: the router's `.output()` (zod from `@mocco/common`) is the wire boundary — `z.object` **strips unknown keys at runtime**, so the full row genuinely becomes the DTO (e.g. `connectionSchema` drops `externalAccountId`). Types live once in `@mocco/common` as zod schemas.
  - **Surfaces without `.output()`** (the ext/Hono routes): the **service** is the narrowing boundary and must **project explicitly** (`return { workspaceId: row.workspaceId }`), because nothing downstream strips the row.
- **A narrow return-type over a wide runtime object is a lie — avoid it.** `async consume(): Promise<{ workspaceId }>` that `return row` (a full row) compiles via structural typing, but the object still carries every column at runtime (raw tokens, timestamps). The type hides them; a later spread/log/serialize surfaces them. Narrow for real (zod `.output()` strips, or an explicit projection at the service) — never let the annotation pretend the object is smaller than it is.

## House rules (lint-enforced)

- **Absolute imports via `@backend/*`, no relative paths**: every internal import uses `@backend/*` (tsconfig `paths → ./src/*`); every relative `./`/`../` is banned (`^\.`). Cross-package stays `@mocco/common/*`. vitest resolves it natively via `resolve.tsconfigPaths` (no plugin). The frontend build resolves the backend's own `@backend/*` imports through a resolution-only cross-map in the frontend tsconfig; the public `exports` whitelist stays the only way frontend *source* reaches the backend.
- **Centralized env access**: `infra/config/env.ts` is the only `process.env` reader — a lazy, zod-validated `getEnv()`. Never read `process.env` inline; add new vars to the schema.
- **No index/barrel files**: never create `index.ts` re-export hubs. Name modules concretely; cross-package consumers go through explicit `package.json` `exports` subpaths.
- **Constants over enums & magic strings**: no TS `enum` — model a fixed set as an `as const` object + derived union type. Reference the exported constant, never a raw domain string. Define each domain constant once.
- **Every control statement takes braces** (`curly: all`); `return await` is required; try/finally is avoided (React Compiler note lives on the frontend, but the return-await rule is shared).

## Testing

Integration tests run on **pglite** (in-memory WASM Postgres) via `infra/db/testing/pglite.ts`, applying the real migrations — no docker needed. Prefer extending those over mocking the DB. Tests compose the same factories production uses (no seams); a tRPC test asserts transport behavior through `appRouter.createCaller(...)` (e.g. a non-member `update` surfaces as `NOT_FOUND`).
