# DB Repository Layer Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every drizzle query out of `ConnectionService` into per-table repository classes under `domain/integration/repos/`, adopting the fi-workers house repo pattern (find*/get*, repo throws `EntityNotFoundError`, service maps to domain errors) adapted to Mocco's constructor-injection + pglite rules, so the first DB-owning domain sets the right template.

**Architecture:** Three instance repos (`ProviderConnectionRepo`, `RepoRepo`, `ConnectStateRepo`), each `constructor(db)`, the sole importers of `drizzle-orm`/schema in the domain. Shared `#backend/infra/db` helpers (`EntityNotFoundError`, `getOrThrow`, `expectOne`). `ConnectionService` keeps its public signatures, holds the repos via injection, and catches `EntityNotFoundError` → rethrows specific domain errors. Lint bans drizzle/schema imports in `*Service.ts`.

**Tech Stack:** TypeScript, drizzle-orm 0.45, pglite (tests), tRPC, ESLint 10 flat config.

**Branch/PR:** Folds into PR #68 (`feat/slice3a-github-connect`) BEFORE it merges — fixing the inline-query template before it lands. **Prerequisites:** (1) `2026-07-15-backend-hash-imports-sweep.md` merged to `main`; (2) `feat/slice3a-github-connect` rebased onto that `main` (existing files now use `#backend/*`). New files here use `#backend/*` imports.

---

## File structure

- **Create** `packages/backend/src/infra/db/errors.ts` — `EntityNotFoundError extends Error` (DB-layer not-found; the Mocco analog of the house `database.errors`).
- **Create** `packages/backend/src/infra/db/rows.ts` — `getOrThrow(rows, message)` (→ row or throw `EntityNotFoundError`) and `expectOne(rows)` (→ row or throw a plain invariant `Error`; replaces the current private `first()`).
- **Create** `packages/backend/src/infra/db/rows.test.ts`.
- **Create** `packages/backend/src/domain/integration/repos/provider-connection.repo.ts` — `ProviderConnectionRepo`.
- **Create** `packages/backend/src/domain/integration/repos/repo.repo.ts` — `RepoRepo`.
- **Create** `packages/backend/src/domain/integration/repos/connect-state.repo.ts` — `ConnectStateRepo`.
- **Modify** `packages/backend/src/domain/integration/ConnectionService.ts` — remove all drizzle; hold repos; map errors.
- **Modify** `packages/backend/src/domain/integration/instance.ts` — build repos from `getDb()`, inject.
- **Modify** tests: `domain/integration/connection.test.ts`, `transport/trpc/routers/integration.test.ts`, `transport/ext/app.test.ts` — build repos over `t.db`.
- **Modify** `packages/backend/eslint.config.mjs` + `eslint.config.base.mjs` — ban drizzle/schema in `*Service.ts` (hoist vendor patterns to a shared const).
- **Create** `docs/adr/0012-repository-per-table-for-db-owning-domains.md`.
- **Modify** `AGENTS.md`.

`Db` type: reuse the existing `type Db = PgDatabase<PgQueryResultHKT, typeof schema>` (import `schema` as `#backend/infra/db/schema`). Repos import it.

---

### Task 1: Shared DB-layer error + row helpers (TDD)

**Files:** Create `infra/db/errors.ts`, `infra/db/rows.ts`, `infra/db/rows.test.ts`.

- [ ] **Step 1: Write failing tests** (`infra/db/rows.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { EntityNotFoundError } from '#backend/infra/db/errors';
import { getOrThrow, expectOne } from '#backend/infra/db/rows';

describe('getOrThrow', () => {
  it('returns the first row', () => {
    expect(getOrThrow([{ id: 1 }], 'x')).toEqual({ id: 1 });
  });
  it('throws EntityNotFoundError with the message when empty', () => {
    expect(() => getOrThrow([], 'no coupon')).toThrow(EntityNotFoundError);
    expect(() => getOrThrow([], 'no coupon')).toThrow('no coupon');
  });
});

describe('expectOne', () => {
  it('returns the first row', () => {
    expect(expectOne([{ id: 1 }])).toEqual({ id: 1 });
  });
  it('throws a plain invariant Error (NOT EntityNotFoundError) when empty', () => {
    expect(() => expectOne([])).toThrow(Error);
    expect(() => expectOne([])).not.toThrow(EntityNotFoundError);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '#backend/infra/db/errors'`)

Run: `yarn workspace @mocco/backend test src/infra/db/rows.test.ts`

- [ ] **Step 3: Implement**

`infra/db/errors.ts`:
```ts
/** A row expected by a lookup was not found. DB-layer; a service maps it to a domain error. */
export class EntityNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EntityNotFoundError';
  }
}
```

`infra/db/rows.ts`:
```ts
import { EntityNotFoundError } from '#backend/infra/db/errors';

/** First row, or throw EntityNotFoundError — for a lookup that may legitimately miss. */
export function getOrThrow<T>(rows: T[], message: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new EntityNotFoundError(message);
  }
  return row;
}

/** First row, or throw a plain invariant Error — for a single-row write guaranteed to return one. */
export function expectOne<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row from a single-row write');
  }
  return row;
}
```

- [ ] **Step 4: Run — expect PASS.** `yarn workspace @mocco/backend test src/infra/db/rows.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/infra/db/errors.ts packages/backend/src/infra/db/rows.ts packages/backend/src/infra/db/rows.test.ts
git commit -m "feat(backend): shared DB-layer EntityNotFoundError + getOrThrow/expectOne helpers"
```

---

### Task 2: `ProviderConnectionRepo` (TDD, pglite)

**Files:** Create `repos/provider-connection.repo.ts`; test via a new `repos/provider-connection.repo.test.ts` (direct pglite test of the tenant-isolation invariant — the highest-value thing to pin at the data boundary).

Methods (from spec): `getById(workspaceId, connectionId)` → row, throws `EntityNotFoundError` if missing/foreign; `findByWorkspace(workspaceId)` → rows; `upsert(workspaceId, provider, { externalAccountId, accountLogin })` → row (conflict target `[provider, externalAccountId]`).

- [ ] **Step 1: Write failing test** — seed a workspace + a connection, assert `getById` returns it, `getById` with a foreign workspaceId throws `EntityNotFoundError`, `findByWorkspace` scopes by workspace, `upsert` inserts then updates on conflict. (Model the setup on the existing `connection.test.ts` — `createTestDb`, seed `workspaces`.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `provider-connection.repo.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '#backend/infra/db/schema';
import { getOrThrow } from '#backend/infra/db/rows';
import { expectOne } from '#backend/infra/db/rows';
import type { Provider } from '@mocco/common/integration';

type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export class ProviderConnectionRepo {
  constructor(private readonly db: Db) {}

  async getById(workspaceId: string, connectionId: string) {
    const rows = await this.db
      .select()
      .from(schema.providerConnections)
      .where(and(eq(schema.providerConnections.id, connectionId), eq(schema.providerConnections.workspaceId, workspaceId)));
    return getOrThrow(rows, `Connection ${connectionId} was not found`);
  }

  async findByWorkspace(workspaceId: string) {
    return await this.db.select().from(schema.providerConnections).where(eq(schema.providerConnections.workspaceId, workspaceId));
  }

  async upsert(workspaceId: string, provider: Provider, input: { externalAccountId: string; accountLogin: string }) {
    return expectOne(
      await this.db
        .insert(schema.providerConnections)
        .values({ workspaceId, provider, externalAccountId: input.externalAccountId, accountLogin: input.accountLogin })
        .onConflictDoUpdate({
          target: [schema.providerConnections.provider, schema.providerConnections.externalAccountId],
          set: { workspaceId, accountLogin: input.accountLogin, status: 'active' },
        })
        .returning(),
    );
  }
}
```
(Consolidate the two `rows` imports into one line to satisfy `import-x/order`; run `lint --fix`.)

- [ ] **Step 4: Run — expect PASS.** `yarn workspace @mocco/backend test src/domain/integration/repos/provider-connection.repo.test.ts`

- [ ] **Step 5: Commit** (`feat(integration): ProviderConnectionRepo`).

---

### Task 3: `RepoRepo` (TDD, pglite)

**Files:** Create `repos/repo.repo.ts`, `repos/repo.repo.test.ts`.

Methods: `findByWorkspace(workspaceId)` → rows; `upsert(row)` → row (conflict target `[connectionId, externalRepoId]`); `updateWatchedBranch(workspaceId, repoId, watchedBranch)` → row, throws `EntityNotFoundError` if 0 rows.

- [ ] **Step 1: Failing test** — seed workspace + connection + repo; assert `updateWatchedBranch` updates and returns, throws `EntityNotFoundError` for a foreign workspace, `upsert` inserts then updates on conflict, `findByWorkspace` scopes.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (mirror the `addRepo`/`setWatchedBranch` queries currently in `ConnectionService`; `updateWatchedBranch` uses `getOrThrow` on the `.returning()` result with message `` `Repo ${repoId} was not found` ``; `upsert` uses `expectOne`). The insert `values` shape is `{ workspaceId, connectionId, externalRepoId, owner, name, defaultBranch, watchedBranch }`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** (`feat(integration): RepoRepo`).

> Naming: file `repo.repo.ts` / class `RepoRepo` is literal (table `repos`). Acceptable; do NOT rename unless the user asked. If it reads too oddly during review, `connected-repo.repo.ts` / `ConnectedRepoRepo` is the pre-approved alternative — behavior identical.

---

### Task 4: `ConnectStateRepo` (TDD, pglite)

**Files:** Create `repos/connect-state.repo.ts`, `repos/connect-state.repo.test.ts`.

Methods: `insert(row)` → void/row (row = `{ state, userId, workspaceId, expiresAt }`); `consume(state, userId, now)` → `{ workspaceId } | undefined` (atomic conditional update: set `consumedAt = now` WHERE `state` AND `userId` AND `consumedAt IS NULL` AND `expiresAt > now`, `.returning()`; **returns undefined on 0 rows — does NOT throw**, because zero rows means invalid/expired, not a lookup miss the service maps to not-found).

- [ ] **Step 1: Failing test** — insert a state, `consume` returns `{ workspaceId }`; a second `consume` of the same state returns `undefined` (already consumed); an expired state returns `undefined`; a foreign `userId` returns `undefined`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (lift the exact query from `ConnectionService.consumeConnectState`; return `rows[0] ? { workspaceId: rows[0].workspaceId } : undefined`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** (`feat(integration): ConnectStateRepo`).

---

### Task 5: Refactor `ConnectionService` onto the repos + map errors

**Files:** Modify `ConnectionService.ts`. The existing `connection.test.ts`, `integration.test.ts`, `app.test.ts` are the regression net — they must stay green (Task 6 updates their construction).

- [ ] **Step 1: Update the deps + drop drizzle**

Change `ConnectionServiceDeps` from `{ db, provider }` to `{ connections: ProviderConnectionRepo; repos: RepoRepo; connectStates: ConnectStateRepo; provider }`. Remove the `import … from 'drizzle-orm'`, the `import * as schema`, the local `first()` and the `Db` type. Keep `Providers`, `randomUUID`, `CONNECT_STATE_TTL_MS`, the domain errors, and the ports import.

- [ ] **Step 2: Rewrite each method to delegate + map errors**

- `requireConnection(ws, id)` (private): `try { return await this.deps.connections.getById(ws, id); } catch (e) { if (e instanceof EntityNotFoundError) throw new ProviderConnectionNotFoundError(id, { cause: e }); throw e; }`
- `startInstall`: compute `state`/`expiresAt`, `await this.deps.connectStates.insert({ state, userId, workspaceId, expiresAt })`, return `{ installUrl: this.deps.provider.installUrl(state) }`.
- `consumeConnectState(state, userId)`: `const r = await this.deps.connectStates.consume(state, userId, new Date()); if (!r) throw new ConnectStateInvalidError(); return r;`
- `createConnection(ws, input)`: `return await this.deps.connections.upsert(ws, Providers.github, input);`
- `listConnections(ws)`: delegate to `connections.findByWorkspace`.
- `listRepos(ws)`: delegate to `repos.findByWorkspace`.
- `availableRepos(ws, connectionId)`: `const c = await this.requireConnection(ws, connectionId); return await this.deps.provider.listRepos(c.externalAccountId);` (unchanged shape).
- `addRepo(ws, input)`: `const c = await this.requireConnection(ws, input.connectionId); const available = await this.deps.provider.listRepos(c.externalAccountId); const match = available.find(r => r.externalRepoId === input.externalRepoId); if (!match) throw new RepoNotFoundError(input.externalRepoId); return await this.deps.repos.upsert({ workspaceId: ws, connectionId: c.id, externalRepoId: match.externalRepoId, owner: match.owner, name: match.name, defaultBranch: match.defaultBranch, watchedBranch: input.watchedBranch });`
- `setWatchedBranch(ws, repoId, watchedBranch)`: `try { return await this.deps.repos.updateWatchedBranch(ws, repoId, watchedBranch); } catch (e) { if (e instanceof EntityNotFoundError) throw new RepoNotFoundError(repoId, { cause: e }); throw e; }`

Import `EntityNotFoundError` from `#backend/infra/db/errors`.

- [ ] **Step 3: Typecheck** — `yarn workspace @mocco/backend ts-check`. Expected: FAILS only in the three test files (deps shape) — Task 6. The service + `root.ts`/handler wiring compile once `instance.ts` is updated, so also do Task 5b before typechecking clean.

- [ ] **Step 5b: Update the composition root** (`instance.ts`)

Replace `new ConnectionService({ db: getDb(), provider })` with:
```ts
const db = getDb();
state.integration = {
  connection: new ConnectionService({
    connections: new ProviderConnectionRepo(db),
    repos: new RepoRepo(db),
    connectStates: new ConnectStateRepo(db),
    provider,
  }),
  provider,
};
```
Import the three repos from `#backend/domain/integration/repos/...`.

- [ ] **Step 6: Commit** (service + instance together; tests still red until Task 6 — note this in the message or fold Task 6 into the same commit).

---

### Task 6: Update the three test construction sites

**Files:** `domain/integration/connection.test.ts` (1 site), `transport/trpc/routers/integration.test.ts` (1 site), `transport/ext/app.test.ts` (5 sites).

- [ ] **Step 1: Replace each `new ConnectionService({ db: t.db, provider … })`** with the repo-built deps:
```ts
new ConnectionService({
  connections: new ProviderConnectionRepo(t.db),
  repos: new RepoRepo(t.db),
  connectStates: new ConnectStateRepo(t.db),
  provider: fakeProvider(...),
})
```
Add the repo imports (`#backend/domain/integration/repos/...`). A tiny local helper `integrationDeps(t.db, provider)` in each test file avoids repeating the three-repo object (esp. app.test.ts's 5 sites) — DRY.

- [ ] **Step 2: Run the full backend suite** — `yarn workspace @mocco/backend test`. Expected: PASS (79 tests, unchanged behavior).

- [ ] **Step 3: Commit** (`test(integration): build ConnectionService over repos`), or fold into Task 5's commit if kept together.

---

### Task 7: Lint-ban drizzle/schema imports in `*Service.ts`

**Files:** `eslint.config.base.mjs` (hoist shared vendor patterns), `packages/backend/eslint.config.mjs`.

- [ ] **Step 1: Hoist the vendor `no-restricted-imports` patterns to a shared const**

`no-restricted-imports` arrays don't merge across flat-config objects (the last matching object wins), so the new `*Service.ts` block would silently drop the better-auth ban unless it re-includes those patterns. In `eslint.config.base.mjs`, export a `const vendorImportPatterns = [ … the two auth/provider + better-auth patterns … ]` (moved from the backend config). Backend's existing vendor block spreads it: `patterns: [...vendorImportPatterns]`.

- [ ] **Step 2: Add the `*Service.ts` block** (composed from the shared const):

```js
{
  files: ['src/domain/**/*Service.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      ...vendorImportPatterns,
      { group: ['drizzle-orm', 'drizzle-orm/*'], message: 'A service reaches the DB through its repo (domain/<d>/repos/*.repo.ts), never drizzle directly.' },
      { group: ['**/infra/db/schema', '#backend/infra/db/schema'], message: 'A service reaches the DB through its repo, not the schema.' },
    ] }],
  },
},
```
(This block, matching `*Service.ts`, wins over the vendor-only block for those files — hence the spread. Test files keep the existing `no-restricted-imports: 'off'`.)

- [ ] **Step 3: Verify** — `yarn workspace @mocco/backend lint`. Expected: PASS (ConnectionService no longer imports drizzle/schema; AuthService/WorkspaceService never did). Then a scratch check: temporarily add `import { eq } from 'drizzle-orm';` to `ConnectionService.ts` → `lint` FAILS with the repo message → revert.

- [ ] **Step 4: Commit** (`chore(lint): services reach the DB only through repos`).

---

### Task 8: ADR 0012 + AGENTS.md, verify, fold into #68

**Files:** Create `docs/adr/0012-repository-per-table-for-db-owning-domains.md`; modify `AGENTS.md`.

- [ ] **Step 1: Write ADR 0012** — decision, context (first DB-owning domain; auth is vendor-mediated), the house pattern + the one deviation (instance injection, not static+singleton, for the pglite seam), consequences (per-table repos, EntityNotFoundError→domain-error mapping, lint). Follow the format of `docs/adr/0011-*`.

- [ ] **Step 2: AGENTS.md** — one line in Code-style / Backend-layering: "A domain that owns `mocco_` tables centralizes drizzle in per-table `domain/<d>/repos/<t>.repo.ts` (instance-injected); services reach the DB only through repos (lint-enforced) and map `EntityNotFoundError` to domain errors. Vendor-mediated domains (auth) are exempt."

- [ ] **Step 3: Full verify** — `yarn verify`. Expected: PASS (all packages, 79+ backend tests, drift gates). Confirm `grep -rn "drizzle-orm\|infra/db/schema" packages/backend/src/domain/integration/ConnectionService.ts` returns nothing.

- [ ] **Step 4: Commit + push to the slice3a branch**

```bash
git add docs/adr/0012-*.md AGENTS.md
git commit -m "docs(adr): 0012 — repository per table for DB-owning domains"
git push origin feat/slice3a-github-connect
```

- [ ] **Step 5: Update PR #68 body** — note the repo-layer refactor folded in (the inline-query template never reaches main). Human merges.

---

## Verification (whole plan)

- `yarn verify` green; `ConnectionService.ts` imports no drizzle/schema (grep + lint).
- 79 backend tests pass through the repos; `rows.test.ts` + three `*.repo.test.ts` added and green.
- Public signatures unchanged: tRPC router, ext route, `@mocco/common` untouched (git diff shows no changes there beyond imports).
- Scratch `drizzle-orm` import in a `*Service.ts` fails lint (rule active).
