---
title: Backend conventions (domain / infra / transport)
description: How packages/backend is written — layering and dependency direction, vendor isolation, constructor-injected services, domain errors mapped to transport codes per router, and the lint-enforced house rules.
type: reference
status: active
created: 2026-07-13
updated: 2026-07-13
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
- **`transport/`** — the edges (`trpc/`, later a Hono `ext/` for external REST). A transport carries **no business logic** — it parses at the boundary (zod from `@mocco/common`) and delegates to a domain service, so logic is never duplicated across surfaces.

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

## Types & schemas

- **Derive types from values** (has-a, not is-a): prefer `z.infer` / `ReturnType<typeof factory>` over hand-maintained parallel interfaces. Write explicit annotations only where they pin a boundary (e.g. a neutral return type that stops vendor inference from leaking).
- **Egress is the tRPC `.output()` schema.** Services return raw vendor rows; the router's `.output()` (zod from `@mocco/common`) is the wire boundary — it strips unknown vendor fields and normalizes. Types live once in `@mocco/common` as zod schemas.

## House rules (lint-enforced)

- **Centralized env access**: `infra/config/env.ts` is the only `process.env` reader — a lazy, zod-validated `getEnv()`. Never read `process.env` inline; add new vars to the schema.
- **No index/barrel files**: never create `index.ts` re-export hubs. Name modules concretely; cross-package consumers go through explicit `package.json` `exports` subpaths.
- **Constants over enums & magic strings**: no TS `enum` — model a fixed set as an `as const` object + derived union type. Reference the exported constant, never a raw domain string. Define each domain constant once.
- **Every control statement takes braces** (`curly: all`); `return await` is required; try/finally is avoided (React Compiler note lives on the frontend, but the return-await rule is shared).

## Testing

Integration tests run on **pglite** (in-memory WASM Postgres) via `infra/db/testing/pglite.ts`, applying the real migrations — no docker needed. Prefer extending those over mocking the DB. Tests compose the same factories production uses (no seams); a tRPC test asserts transport behavior through `appRouter.createCaller(...)` (e.g. a non-member `update` surfaces as `NOT_FOUND`).
