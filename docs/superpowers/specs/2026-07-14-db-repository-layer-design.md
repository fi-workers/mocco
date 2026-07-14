# DB repository layer for table-owning domains

Date: 2026-07-14
Status: Approved (design)
Branch: `feat/slice3a-github-connect` (refactors PR #68 before merge)

## Problem

`ConnectionService` (slice 3a) is the **first domain in the codebase to own its own
`mocco_` tables and access the DB directly** — `auth` is vendor-mediated (every query
goes through better-auth's `provider.api.*`), so it set no precedent for raw data
access. `ConnectionService` embeds drizzle queries inline across ~10 call sites
(`this.deps.db.select().from(schema...)`, `.insert()`, `.update()...onConflictDoUpdate`).

Because it is the first, whatever shape it lands in becomes the **template every future
DB-owning governance domain copies**. Inline queries scattered through service methods
mix data access with business policy and give no single place to reason about a domain's
persistence. We want to fix it before #68 merges, so the bad template never reaches main.

## Decision

A domain that owns `mocco_` tables centralizes **all** its drizzle queries in a single
`<Domain>Repository` class. The service depends on the repository (constructor-injected,
matching the existing `provider` seam) and **never imports `drizzle-orm` or the db
schema**. This is **query centralization only** — see Non-goals for what it is *not*.

Scope: the `integration` domain (the only current DB-owning domain). `auth` is unaffected
(vendor-mediated). The rule is documented (ADR + AGENTS.md) and lint-enforced so the next
DB-owning domain follows it by construction.

## Design

### `ConnectionRepository` (new: `domain/integration/ConnectionRepository.ts`)

- `constructor(private readonly db: Db)` where `Db = PgDatabase<PgQueryResultHKT, typeof schema>`
  (the same broad type the service uses today, so pglite test db and node-postgres prod db
  both satisfy it).
- A **single** repository covers the domain's three tables (`providerConnections`, `repos`,
  `githubConnectStates`) — they are all part of one connection lifecycle; splitting per
  table is unjustified (YAGNI).
- It is the **sole importer of `infra/db/schema` and `drizzle-orm` within the domain.**

**Responsibility split — repository = data access only, service = policy:**

- The repository runs queries and returns rows (or `undefined` / arrays). It does **not**
  throw domain errors and does **not** call the provider.
- The **tenant-isolation invariant lives in the repository**: every query that reaches a
  connection or repo is scoped by `workspaceId` in its `WHERE` clause (a repo is never
  reachable by `externalRepoId` alone). Keeping the scoping at the data-access boundary is
  the whole point — the invariant is enforced where the query is written.
- The service keeps: throwing domain errors on `undefined` (`ProviderConnectionNotFoundError`,
  `ConnectStateInvalidError`, `RepoNotFoundError`), TTL/`expiresAt` computation, ownership of
  the `Providers.github` constant, and all `provider.listRepos(...)` calls plus the
  "find the matching available repo" logic in `addRepo`. `Providers.github` stays in the
  service and is **passed into** `upsertConnection(workspaceId, provider, ...)` as an
  argument (the repository writes it into `values` and uses `[provider, externalAccountId]`
  as the conflict target) — the repository does not import the `Providers` constant, keeping
  the "service owns the domain constant" split intact.
- The `first()` helper (single-row-write assertion) moves into the repository — it is a
  data-access concern.

**Method surface** (data-access; names describe the operation, no `get`/`set`/`add` verb
prefixes per house naming):

| Repository method | Replaces (service today) |
|---|---|
| `insertConnectState(row)` | `startInstall`'s insert |
| `consumeState(state, userId, now)` → `{ workspaceId } \| undefined` | `consumeConnectState`'s atomic update |
| `upsertConnection(workspaceId, provider, { externalAccountId, accountLogin })` → row | `createConnection` |
| `findConnection(workspaceId, connectionId)` → row \| `undefined` | `requireConnection` (private) |
| `listConnections(workspaceId)` → row[] | `listConnections` |
| `listRepos(workspaceId)` → row[] | `listRepos` |
| `upsertRepo(row)` → row | `addRepo`'s insert |
| `updateWatchedBranch(workspaceId, repoId, watchedBranch)` → row \| `undefined` | `setWatchedBranch`'s update |

The service's public method signatures (`startInstall`, `consumeConnectState`,
`createConnection`, `availableRepos`, `addRepo`, `setWatchedBranch`, `listConnections`,
`listRepos`) are **unchanged** — this is a pure internal refactor. tRPC router, the Hono
`ext` setup route, and `@mocco/common` types are untouched.

### Injection & composition

- Service deps change from `{ db, provider }` to `{ connections: ConnectionRepository, provider }`.
  The service no longer receives a raw `db`.
- The **only production composition root** that constructs `ConnectionService` is
  `domain/integration/instance.ts:37` (`new ConnectionService({ db: getDb(), provider })`) —
  it becomes `new ConnectionService({ connections: new ConnectionRepository(getDb()), provider })`.
  The tRPC and ext transports consume the already-built service via `getIntegration().connection`;
  they do not construct it, so no other production wiring changes.

### Tests

- **Three test files** construct `ConnectionService` themselves and must move to the new
  deps shape (`{ connections: new ConnectionRepository(t.db), provider }` in place of
  `{ db: t.db, provider }`) — the deps-type change is compile-breaking, so all three fail
  `tsc` until updated:
  - `domain/integration/connection.test.ts` (1 site)
  - `transport/trpc/routers/integration.test.ts` (1 site)
  - `transport/ext/app.test.ts` (5 sites)
- Tests **still run against real pglite** — test speed is explicitly not a goal, so no
  in-memory fake repository is introduced. Queries now flow through the repository; coverage
  and assertions are unchanged. This is minimal churn (each site swaps the deps object; add
  the `ConnectionRepository` import).

### Lint enforcement

Add a backend eslint block scoped to domain **service** files banning the data-access
imports, so a service can only reach the DB through its repository:

- `files: ['src/domain/**/*Service.ts']`
- `no-restricted-imports` patterns banning `drizzle-orm` (+ `drizzle-orm/*`) and
  `**/infra/db/schema` with a message pointing to "go through the domain's repository".

**Implementation risk (must handle in the plan): `no-restricted-imports` arrays do not
merge across flat-config objects — the last matching object wins.** The existing
vendor-isolation block already sets `no-restricted-imports` for `**/*.ts`. A new
service-scoped block would *override* it for `*Service.ts`, silently dropping the
better-auth/provider ban on those files. The service block must therefore **re-include the
vendor-isolation patterns** (or the shared patterns get hoisted to an exported const in
`eslint.config.base.mjs`, mirroring how `restrictedSyntax` is already shared, and both
blocks compose from it). The plan picks one; the shared-const route is cleaner and is the
recommendation. Test files keep `no-restricted-imports: 'off'` (existing block) so
`*Service.test.ts` and repository tests may import schema freely.

### Documentation

- **ADR 0012** (`docs/adr/0012-repository-for-db-owning-domains.md`): a domain owning
  `mocco_` tables centralizes drizzle in a `<Domain>Repository`; services access the DB only
  through it and never import `drizzle-orm`/schema; vendor-mediated domains (auth) are out of
  scope. Rationale: 3a is the first DB-owning domain, so the template is fixed here; the
  repository is a data-access boundary (queries + tenant-scoping), not a policy layer.
- **AGENTS.md**: one line in the Backend-layering / Code-style area stating the rule, next to
  the existing vendor-isolation and env-centralization rules.

## Non-goals

- **No port/interface abstraction.** The repository is a concrete class that imports drizzle
  directly (within the domain). We are not introducing a domain-side interface with an
  infra-side implementation.
- **No test-speed fake repository.** Tests stay on pglite.
- **No infra/domain split of the repository.** It lives in the domain beside the service.
- **No change to auth.** It is vendor-mediated and owns no `mocco_` tables directly.
- **No public API / signature changes.** Router, ext route, and common types are untouched.

## Verification

`yarn verify` green (79 backend tests pass through the repository), and the new lint block
fails a service file that imports `drizzle-orm`/schema (confirmed by a scratch check, then
reverted).
