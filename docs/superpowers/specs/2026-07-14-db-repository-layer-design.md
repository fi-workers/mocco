# DB repository layer for table-owning domains

Date: 2026-07-14
Status: Approved (design)
Reference: fi-workers house repo pattern — `showyourtime` (`src/backend/src/domains/<d>/repos/<t>.repo.ts`)
and `checkable` (`src/checkable/src/server/apps/<a>/repos/<t>.repo.ts`).

## Problem

`ConnectionService` (slice 3a) is the **first domain in the codebase to own its own
`mocco_` tables and access the DB directly** — `auth` is vendor-mediated (every query goes
through better-auth's `provider.api.*`), so it set no precedent. `ConnectionService` embeds
drizzle queries inline across ~10 call sites. Whatever shape it lands in becomes the
**template every future DB-owning governance domain copies**, so we fix it before PR #68
merges — on the slice3a branch — so the inline-query template never reaches `main`.

The fi-workers house style (showyourtime, checkable) already answers "how does a service
touch the DB": a **repository per table**. Mocco should follow it, adapted to Mocco's own
hard rules.

## The house pattern, and the one conflict

House repos are: one class per table at `<domain>/repos/<table>.repo.ts`; method naming
`find*` (returns array / nullable, never throws) vs `get*` (single row, **throws
`EntityNotFoundError`** when missing) vs `create`/`update`/`upsert`/`delete`; the repo
throws a shared **`EntityNotFoundError`**, and the **service catches it and maps to a
specific domain error** (e.g. `CouponService` catches `EntityNotFoundError` → throws
`CouponError`).

**The conflict:** house repos use `static` methods importing a **module-singleton `db`**.
Mocco forbids exactly that — AGENTS.md: *"Never static classes importing singletons —
explicit constructor arguments are the seam"*; tests build a **fresh pglite db per test**
(`createTestDb()`), which a module singleton can't swap without `vi.mock` (banned, ADR 0008).

**Resolution (chosen): adopt every house convention except static+singleton.** Repos are
**instance classes constructed with `db`** (`new ConnectionRepo(db)`), so pglite injection,
the no-singleton rule, and existing lint all stay intact. The repo-throws-`EntityNotFoundError`
→ service-maps-to-domain-error split is not just compatible but *reinforced* by Mocco's
existing rule (AGENTS.md: "interpreting vendor/DB error shapes happens inside the service,
which throws a domain error class").

## Design

### Repos (new: `domain/integration/repos/`, one per table)

Three instance classes, each `constructor(private readonly db: Db)` where
`Db = PgDatabase<PgQueryResultHKT, typeof schema>` (satisfied by both pglite test db and the
node-postgres prod db). These are the **sole importers of `infra/db/schema` + `drizzle-orm`
within the domain.**

| File | Class | Table | Methods (house naming) |
|---|---|---|---|
| `provider-connection.repo.ts` | `ProviderConnectionRepo` | `providerConnections` | `getById(ws, id)` (throws `EntityNotFoundError`), `findByWorkspace(ws)`, `upsert(ws, provider, {externalAccountId, accountLogin})` — conflict target `[provider, externalAccountId]` |
| `repo.repo.ts` | `RepoRepo` | `repos` | `findByWorkspace(ws)`, `upsert(row)` — conflict target `[connectionId, externalRepoId]`, `updateWatchedBranch(ws, id, branch)` (throws `EntityNotFoundError` if 0 rows) |
| `connect-state.repo.ts` | `ConnectStateRepo` | `githubConnectStates` | `insert(row)`, `consume(state, userId, now)` → row \| `undefined` |

Naming note: `repo.repo.ts` / `RepoRepo` is literal-but-awkward (the table is named `repos`).
The plan may rename to `connected-repo.repo.ts` / `ConnectedRepoRepo` if preferred; behavior
is identical either way.

**Tenant-isolation invariant lives in the repos.** Every read/update that reaches a
connection or repo is scoped by `workspaceId` in its `WHERE` clause — a repo is never
reachable by `externalRepoId` alone. Keeping the scoping at the data-access boundary is the
point: the invariant is enforced where the query is written.

**`get*` throws `EntityNotFoundError`; `find*` does not.** `consume` is a conditional atomic
update, not a lookup, so it returns `undefined` on zero rows (the service interprets it —
`ConnectStateInvalidError`, not "not found").

### Shared single-row helper (the `first()` concern — "managed separately")

The current private `first()` in `ConnectionService` moves out to **shared helpers in
`infra/db/`**, separately managed (not a per-service/per-repo inline). Two semantically
distinct cases — keep them distinct:

- **Lookup that may legitimately miss** (`getById`, `updateWatchedBranch`'s 0-row case) →
  `getOrThrow(rows, message)` returns `rows[0]` or throws **`EntityNotFoundError`**.
- **Single-row write guaranteed to return a row** (`upsert`, `insert…returning`) → `expectOne(rows)`
  returns `rows[0]` or throws a plain invariant `Error` ("expected one row from a single-row
  write") — a can't-happen assert, NOT a not-found. This preserves the current `first()`
  semantics rather than conflating them with `EntityNotFoundError`.

Add `infra/db/errors.ts` exporting `EntityNotFoundError extends Error` (a DB-layer error,
the Mocco equivalent of the house `database.errors`/`database.exceptions` file). Repos throw
it; it never reaches the transport directly.

### Service = policy (maps DB errors → domain errors)

`ConnectionService` keeps its **public method signatures unchanged** (`startInstall`,
`consumeConnectState`, `createConnection`, `availableRepos`, `addRepo`, `setWatchedBranch`,
`listConnections`, `listRepos`) — pure internal refactor; tRPC router, Hono `ext` route, and
`@mocco/common` types are untouched. It now:

- Holds the repos + provider via constructor injection (see below), imports **no**
  `drizzle-orm`/schema.
- **Catches `EntityNotFoundError` from `get*`/`update*` and rethrows the specific domain
  error** with the caught error as `cause` — mirroring `CouponService`'s catch-and-map:
  `ProviderConnectionRepo.getById` → `ProviderConnectionNotFoundError`;
  `RepoRepo.updateWatchedBranch` 0-row → `RepoNotFoundError`. `ConnectStateInvalidError` is
  thrown by the service when `consume` returns `undefined`.
- Note `RepoNotFoundError` has a **second, non-DB provenance**: in `addRepo`, when the
  provider's available-repo list has no match (`available.find(...) === undefined`), the
  service throws `RepoNotFoundError` **directly** — this stays a service-level throw and is
  NOT routed through `RepoRepo` (the repo has no say in a provider-list miss).
- Owns the `Providers.github` constant and passes it into `ProviderConnectionRepo.upsert(ws,
  provider, …)` (the repo writes it and uses `[provider, externalAccountId]` as the conflict
  target; the repo does not import `Providers`). Keeps all `provider.listRepos(...)` calls
  and the "find the matching available repo" logic in `addRepo`.

### Injection & composition

- Service deps change from `{ db, provider }` to
  `{ connections: ProviderConnectionRepo, repos: RepoRepo, connectStates: ConnectStateRepo, provider }`.
- The **only production composition root** constructing `ConnectionService` is
  `domain/integration/instance.ts:37`. It builds the three repos from `getDb()` once and
  passes them in.

### Tests

Three test files construct `ConnectionService` themselves and move to the new deps shape
(build the three repos over `t.db` instead of passing `db`) — the deps-type change is
compile-breaking, so all three fail `tsc` until updated:

- `domain/integration/connection.test.ts` (1 site)
- `transport/trpc/routers/integration.test.ts` (1 site)
- `transport/ext/app.test.ts` (5 sites)

Tests **still run against real pglite** — test speed is explicitly not a goal, so no
in-memory fake repo is introduced. Queries flow through the repos; coverage and assertions
are unchanged.

### Lint enforcement

A backend eslint block scoped to `src/domain/**/*Service.ts` bans importing `drizzle-orm`
(+`drizzle-orm/*`) and `**/infra/db/schema`, forcing DB access through a repo.

**Risk (handle in the plan): `no-restricted-imports` arrays don't merge across flat-config
objects — the last matching object wins.** The existing vendor-isolation block already sets
`no-restricted-imports` for `**/*.ts`; a service-scoped block would override it for
`*Service.ts` and silently drop the better-auth ban. Hoist the shared vendor patterns to an
exported const in `eslint.config.base.mjs` (mirroring the already-shared `restrictedSyntax`)
and compose both blocks from it. Test files keep `no-restricted-imports: 'off'` (existing
block) so `*.test.ts` may import schema freely.

### Documentation

- **ADR 0012** (`docs/adr/0012-repository-per-table-for-db-owning-domains.md`): a domain
  owning `mocco_` tables puts one `<table>.repo.ts` per table under `<domain>/repos/`;
  services reach the DB only through repos and never import `drizzle-orm`/schema; repos throw
  `EntityNotFoundError`, services map to domain errors; instance-injected (not static +
  singleton) to honor Mocco's pglite seam. Cites the fi-workers house pattern and the one
  deviation (injection).
- **AGENTS.md**: one line in the Backend layering / Code-style area, beside vendor-isolation
  and env-centralization.

## Absolute imports — dependency, not part of this refactor

New repo files should import via a **named, package-identifying alias**, matching the
fi-workers house convention where the alias *is the package name* (`@fw/backend/*`,
`@fw/checkable/*`) and Mocco's own existing cross-package imports (`@mocco/common/*`). The
generic `@/` (frontend, #52) was rejected as ambiguous across a monorepo.

**Alias: `@mocco/backend/* → ./src/*`.** Internal imports become
`@mocco/backend/infra/db/schema`, `@mocco/backend/domain/integration/repos/...`, etc. — every
import self-identifies by package name regardless of file location.

- No collision with the package's public `exports` contract (`./auth/instance`, `./trpc/root`):
  the `exports` map gates *external* consumers, while the tsconfig `paths` alias is *internal*
  TS resolution — separate resolution contexts (the same split the house relies on).

**Mocco backend has no alias today** (`packages/backend/tsconfig.json` sets no `paths`).
Adding it is a backend-wide sweep unrelated to GitHub-connect, so it ships as a **separate
precursor PR off `main`**: add `@mocco/backend/* → ./src/*` to the backend tsconfig, wire the
eslint import resolver, add a `no-restricted-imports` ban on relative-parent (`^\.\./`)
imports, and convert existing `../`→`@mocco/backend/`.

**Sequencing:** (1) the `@/` precursor PR merges to `main`; (2) slice3a (#68) rebases onto
`main`; (3) the repository refactor is added to #68 with `@/` imports and folded in before
the human merges #68. The repo refactor therefore waits on the `@/` PR merging first.

## Non-goals

- **No port/interface abstraction.** Repos are concrete classes importing drizzle directly
  (within the domain). No domain-side interface + infra-side impl.
- **No static + singleton `db`.** That is the one house deviation, for Mocco's pglite seam.
- **No test-speed fake repo.** Tests stay on pglite.
- **No change to auth.** Vendor-mediated; owns no `mocco_` tables directly.
- **No public API / signature changes.** Router, ext route, common types untouched.
- **The `@/` backend sweep is out of scope of this refactor** — separate precursor PR.

## Verification

`yarn verify` green (79 backend tests pass through the repos), and the new lint block fails a
service file that imports `drizzle-orm`/schema (scratch-checked, then reverted).
