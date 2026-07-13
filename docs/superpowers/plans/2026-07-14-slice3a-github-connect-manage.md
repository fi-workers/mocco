# Slice 3a — GitHub Connect & Manage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace connect a GitHub App installation (with proven ownership), register repositories with a watched branch, and see real repos on the dashboard — read-only, tenant-isolated, no commit sync yet.

**Architecture:** GitHub is the first `provider` plugging into a provider-agnostic core. Domain ports (`RepoLister`, `InstallationVerifier`) live in `domain/integration`; the octokit-importing adapter is a domain leaf (`domain/integration/github/provider.ts`, mirroring `domain/auth/provider.ts`). `ConnectionService` (constructor-injected `db` + ports) owns our own `mocco_*` tables. The install setup callback is an **App-Router Hono** ext route (first `app/` file); everything else is tRPC + the CSR Pages-Router UI.

**Tech Stack:** `@octokit/app` (installation tokens, OAuth), `hono` (ext REST on App Router), drizzle (our tables), tRPC (internal), react-hook-form + zod (UI), pglite (tests).

**Spec:** `docs/superpowers/specs/2026-07-13-slice3-github-integration-observation-design.md`. **This is one PR** (`feat/slice3a-github-connect`). Base = `main`. `yarn verify` green before push (pre-push enforces).

**Scope boundary (do NOT build here):** no webhook, no `mocco_commits`/`mocco_commit_configs`, no commit sync/backfill, no `CommitSource`/`WebhookParser`, no `@vercel/functions`, no `GITHUB_WEBHOOK_SECRET` — those are 3b/3c. 3a only supports `setup_action=install` (installation_id present on the callback); the `request` path just shows a "pending" UI state.

---

## File Structure

**New files**
- `docs/adr/0011-external-api-surface-architecture.md` — the ext-surface decision (App Router, paths, tunnel exception).
- `packages/common/src/integration.ts` — neutral zod: `Providers` const + `providerSchema`, `connectionSchema`/`ConnectionDto`, `repoSchema`/`RepoDto`, connect input schemas.
- `packages/backend/src/domain/integration/ports.ts` — `RepoLister`, `InstallationVerifier` interfaces + neutral arg/return types.
- `packages/backend/src/domain/integration/constants.ts` — `ConnectionStatuses`, `RepoStatuses` const unions (+ backfill constants, used by 3b, defined here).
- `packages/backend/src/domain/integration/errors.ts` — `ProviderConnectionNotFoundError`, `RepoNotFoundError` (extend `NotFoundError`), `OwnershipNotVerifiedError`, `ConnectStateInvalidError`.
- `packages/backend/src/domain/integration/ConnectionService.ts` — our-tables service (constructor `{ db, repoLister }`).
- `packages/backend/src/domain/integration/github/provider.ts` — the ONLY `@octokit/app` importer; implements `RepoLister` + `InstallationVerifier`; install-URL/state helpers; `toRepo` mapper.
- `packages/backend/src/domain/integration/github/errors.ts` — octokit error → domain error translation helper.
- `packages/backend/src/domain/integration/instance.ts` — composition root for integration services (mirrors `domain/auth/instance.ts`).
- `packages/backend/src/transport/trpc/routers/integration.ts` — `integrationRouter` (+ router-scoped `NotFoundError` middleware).
- `packages/backend/src/transport/ext/app.ts` — the Hono app (setup callback route) + `extHandler(request): Promise<Response>` fetch handler.
- `packages/frontend/src/app/api/ext/[[...route]]/route.ts` — first `app/` file; delegates to the backend `extHandler`.
- Frontend: `packages/frontend/src/components/repo-list.tsx`, `connect-github-button.tsx` (new UI pieces).

**Modified files**
- `packages/common/package.json` — add `"./integration": "./src/integration.ts"` export.
- `packages/backend/package.json` — add deps (`@octokit/app`, `@octokit/plugin-throttling`, `@octokit/plugin-retry`, `hono`) + export `"./ext/app"`.
- `packages/backend/src/infra/config/env.ts` — add GitHub App env vars.
- `packages/backend/src/infra/db/schema.ts` — add `mocco_provider_connections`, `mocco_repos`, `mocco_github_connect_states`.
- `packages/backend/src/transport/trpc/trpc.ts` — add integration services to `Context`.
- `packages/backend/src/transport/trpc/root.ts` — add `integration: integrationRouter`.
- `packages/backend/src/transport/trpc/handler.ts` + `packages/frontend/src/pages/api/trpc/[trpc].ts` — thread integration services into the caller `Context`.
- `packages/frontend/src/components/workspace-overview.tsx` — replace the disabled placeholder with the real connect + repo-list UI (thread `workspaceId`).
- `packages/frontend/src/pages/workspaces/[id]/index.tsx` — pass `workspaceId` to `WorkspaceOverview`.
- `packages/frontend/src/lib/routes.ts` — no new page routes needed (install starts via a mutation → full nav to GitHub; callback returns to `/workspaces/[id]`), but add a helper if a dedicated landing is chosen.
- `AGENTS.md` — one line: ext surfaces live on the App Router (link ADR 0011).

---

## Task 0: ADR 0011 — external API surface architecture

**Files:** Create `docs/adr/0011-external-api-surface-architecture.md`; Modify `AGENTS.md`.

- [ ] **Step 1: Write the ADR** (English, kebab, matches the 0001–0010 frontmatter shape — copy the header block from `docs/adr/0010-*.md`). Body records:
  - **Decision:** external inbound (GitHub setup callback, webhooks) is served by a **Hono** app mounted under the Next **App Router** at `packages/frontend/src/app/api/ext/[[...route]]/route.ts` via `hono/vercel` `handle()`. The App and Pages routers coexist (Next 16). Internal frontend↔backend stays tRPC on the Pages Router.
  - **Why App Router (not Pages):** `hono/vercel handle()` targets fetch-standard `Request`/`Response` route handlers; mounted in a Pages catch-all it hits Next's bodyParser, which consumes the raw stream that webhook HMAC verification (3b) needs.
  - **Concrete paths:** setup callback `GET /api/ext/github/setup`; webhook (3b) `POST /api/ext/github/webhook`.
  - **Supersedes:** roadmap §8 (which mounted ext at a Pages route) and resolves roadmap §10 open-Q3; reconciles ADR 0006's `/api/webhooks/github` path.
  - **Tunnel exception (3b):** local dev webhook target is `hooks.mocco.club` (a `mocco.club` subdomain), a recorded exception to ADR 0006's `mocco.work = local` split, because `mocco.work` is not on public DNS while `mocco.club` is already on Cloudflare.
- [ ] **Step 2: Add the AGENTS.md pointer** — under "PR conventions" / API surfaces, add: "External inbound (webhooks, setup callbacks) is a Hono app on the App Router — see [ADR 0011](./docs/adr/0011-external-api-surface-architecture.md)."
- [ ] **Step 3: Commit** — `git add docs/adr/0011-external-api-surface-architecture.md AGENTS.md && git commit -m "docs: ADR 0011 — external API surface on the App Router"`

_No test (docs). This lands first because the whole slice's transport shape depends on it._

---

## Task 1: Dependencies + env vars

**Files:** Modify `packages/backend/package.json`, `packages/backend/src/infra/config/env.ts`; Test `packages/backend/src/infra/config/env.test.ts` (create if absent).

- [ ] **Step 1: Add exact-pinned deps** to `packages/backend/package.json` dependencies (verify current stable versions on npm at implementation time; the spec pins `@octokit/app@16.1.2`): `@octokit/app`, `@octokit/plugin-throttling`, `@octokit/plugin-retry`, `hono`. No `^`/`~`. Run `yarn install` (updates `yarn.lock`).
- [ ] **Step 2: Write the failing env test.** `getEnv()` memoizes in a module-private `state` with NO exported reset, so each case must get a fresh module: use `vi.resetModules()` + a dynamic `import('./env')` per case (and set `process.env` before importing). Always set `DATABASE_URL` (it's required — `.min(1)` — and is parsed before the GitHub vars, so omitting it masks the assertion). Cover: valid vars decode; `GITHUB_APP_PRIVATE_KEY_B64` holding a PKCS#1 PEM throws `/PKCS#8/`.

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const base = { DATABASE_URL: 'postgres://x', GITHUB_APP_ID: '4284809',
  GITHUB_APP_SLUG: 'mocco-club', GITHUB_APP_CLIENT_ID: 'Iv1', GITHUB_APP_CLIENT_SECRET: 's' };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllEnvs(); });

it('rejects a PKCS#1 private key', async () => {
  for (const [k, v] of Object.entries({ ...base,
    GITHUB_APP_PRIVATE_KEY_B64: Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----').toString('base64'),
  })) vi.stubEnv(k, v);
  const { getEnv } = await import('./env');
  expect(() => getEnv()).toThrow(/PKCS#8/);
});
```

- [ ] **Step 3: Run it — expect FAIL** (`yarn backend test env`).
- [ ] **Step 4: Extend the zod schema** in `env.ts`. Add the vars. For the private key, use a `.transform` that base64-decodes and asserts PKCS#8 (do NOT import a crypto lib — string check only, per spec):

```ts
GITHUB_APP_ID: z.string().min(1).optional(),
GITHUB_APP_SLUG: z.string().min(1).optional(),   // the App's public slug, for the install URL
GITHUB_APP_PRIVATE_KEY_B64: z.string().min(1).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  const pem = Buffer.from(v, 'base64').toString('utf8');
  if (!pem.includes('BEGIN PRIVATE KEY')) {
    ctx.addIssue({ code: 'custom', message: 'GITHUB_APP_PRIVATE_KEY_B64 must be a base64 PKCS#8 PEM (convert once: openssl pkcs8 -topk8 -nocrypt)' });
    return z.NEVER;
  }
  return pem;
}),
GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
```

_These are `.optional()` so existing deploys/tests without GitHub configured keep booting; the adapter throws a clear domain error if it's constructed without them (Task 5)._ Add placeholders to `packages/frontend/.env.example`.

- [ ] **Step 5: Run test — expect PASS.**
- [ ] **Step 6: Commit** — `git add packages/backend/package.json yarn.lock packages/backend/src/infra/config/env.ts packages/backend/src/infra/config/env.test.ts packages/frontend/.env.example && git commit -m "feat(integration): add octokit/hono deps + GitHub App env vars"`

---

## Task 2: Neutral `@mocco/common` integration schemas

**Files:** Create `packages/common/src/integration.ts`; Modify `packages/common/package.json`; Test `packages/common/src/integration.test.ts`.

Follow `packages/common/src/workspace.ts` shape (input schema + inferred type + entity schemas + `*Dto`). Neutral field naming (spec: `defaultBranch`, `externalRepoId`, no GitHub-only fields).

- [ ] **Step 1: Failing test** — assert `providerSchema` accepts `'github'` and rejects `'gitlab'` today; `repoSchema` round-trips a neutral repo.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (constants-over-enums per AGENTS.md):

```ts
import { z } from 'zod';

export const Providers = { github: 'github' } as const;
export type Provider = (typeof Providers)[keyof typeof Providers];
export const providerSchema = z.enum(Object.values(Providers) as [Provider, ...Provider[]]);

export const connectionSchema = z.object({
  id: z.uuid(), provider: providerSchema, accountLogin: z.string(),
});
export type ConnectionDto = z.infer<typeof connectionSchema>;

export const repoSchema = z.object({
  id: z.uuid(), connectionId: z.uuid(), externalRepoId: z.string(),
  owner: z.string(), name: z.string(), defaultBranch: z.string(),
  watchedBranch: z.string().nullable(),
});
export type RepoDto = z.infer<typeof repoSchema>;

// live (not-yet-connected) repos returned from the provider for the picker
export const availableRepoSchema = z.object({
  externalRepoId: z.string(), owner: z.string(), name: z.string(), defaultBranch: z.string(),
});
export type AvailableRepoDto = z.infer<typeof availableRepoSchema>;

export const addRepoInputSchema = z.object({
  connectionId: z.uuid(), externalRepoId: z.string(),
  watchedBranch: z.string().min(1).nullable().default(null),
});
export const setWatchedBranchInputSchema = z.object({ repoId: z.uuid(), watchedBranch: z.string().min(1).nullable() });
```

- [ ] **Step 4: Add the export** to `packages/common/package.json`: `"./integration": "./src/integration.ts"`.
- [ ] **Step 5: Run test — PASS.**
- [ ] **Step 6: Commit** — `feat(common): neutral integration schemas (provider/connection/repo)`

---

## Task 3: DB schema + migration (3a tables)

**Files:** Modify `packages/backend/src/infra/db/schema.ts`; generate a migration under `packages/backend/src/infra/db/migrations/`; Test `packages/backend/src/domain/integration/schema.test.ts`.

Mirror the `mocco_members` example (uuid PK, snake_case columns, FK `onDelete`, `uniqueIndex`, `check`). Add the three tables (spec "Data model"):

- [ ] **Step 1: Failing test (pglite)** — `createTestDb()`, then insert a connection + repo and assert the unique constraints & FK cascade behave. E.g. two repos with the same `(connection_id, external_repo_id)` → the 2nd insert rejects; deleting a connection cascades its repos.
- [ ] **Step 2: Run — FAIL** (tables don't exist).
- [ ] **Step 3: Add tables to `schema.ts`:**

```ts
export const providerConnections = pgTable('mocco_provider_connections', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  externalAccountId: text('external_account_id').notNull(),
  accountLogin: text('account_login').notNull(),
  status: text().notNull().default('active'),
  createdAt,
}, t => [
  uniqueIndex('mocco_provider_connections_provider_account_uq').on(t.provider, t.externalAccountId),
  uniqueIndex('mocco_provider_connections_id_workspace_uq').on(t.id, t.workspaceId),
  check('mocco_provider_connections_provider_check', sql`${t.provider} IN ('github')`),
  check('mocco_provider_connections_status_check', sql`${t.status} IN ('active','suspended','deleted')`),
]);

export const repos = pgTable('mocco_repos', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  connectionId: uuid('connection_id').notNull().references(() => providerConnections.id, { onDelete: 'cascade' }),
  externalRepoId: text('external_repo_id').notNull(),
  owner: text().notNull(), name: text().notNull(),
  defaultBranch: text('default_branch').notNull(),
  watchedBranch: text('watched_branch'),      // NULLABLE = connected-but-not-watching
  status: text().notNull().default('active'),
  connectedAt: timestamp('connected_at').notNull().defaultNow(),
  lastSyncedAt: timestamp('last_synced_at'),
}, t => [
  uniqueIndex('mocco_repos_connection_repo_uq').on(t.connectionId, t.externalRepoId),
  // composite FK: guard the denormalized workspace_id against drift
  foreignKey({ columns: [t.connectionId, t.workspaceId], foreignColumns: [providerConnections.id, providerConnections.workspaceId] }),
  check('mocco_repos_status_check', sql`${t.status} IN ('active','inactive')`),
]);

export const githubConnectStates = pgTable('mocco_github_connect_states', {
  state: text().primaryKey(),
  userId: uuid('user_id').notNull(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  githubUserLogin: text('github_user_login'),
  githubUserId: text('github_user_id'),
  createdAt,
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
}, t => [ index('mocco_github_connect_states_workspace_idx').on(t.workspaceId) ]);
```

Import the needed drizzle helpers (`foreignKey`, `check`, `index`, `uniqueIndex`, `sql`) at the top if not present.

- [ ] **Step 4: Generate the migration** — `yarn db:generate` (creates `000N_<slug>.sql` + updates `meta/_journal.json`). Inspect the SQL is sane (three `CREATE TABLE`, the constraints).
- [ ] **Step 5: Run test — PASS** (pglite applies the new migration automatically via `createTestDb`).
- [ ] **Step 6: Commit** — `git add packages/backend/src/infra/db/schema.ts packages/backend/src/infra/db/migrations packages/backend/src/domain/integration/schema.test.ts && git commit -m "feat(integration): mocco_provider_connections/repos/github_connect_states tables"`

---

## Task 4: Ports, constants, errors

**Files:** Create `domain/integration/ports.ts`, `constants.ts`, `errors.ts`. (No standalone test — exercised by service tests.)

- [ ] **Step 1: `constants.ts`** (constants-over-enums):

```ts
export const ConnectionStatuses = { active: 'active', suspended: 'suspended', deleted: 'deleted' } as const;
export type ConnectionStatus = (typeof ConnectionStatuses)[keyof typeof ConnectionStatuses];
export const RepoStatuses = { active: 'active', inactive: 'inactive' } as const;
export type RepoStatus = (typeof RepoStatuses)[keyof typeof RepoStatuses];
export const BACKFILL_DEFAULT_LIMIT = 30;   // used by 3b
export const BACKFILL_MAX_LIMIT = 100;      // used by 3b
```

- [ ] **Step 2: `errors.ts`** (extend the shared base from `domain/errors.ts`, mirror `auth/errors.ts`):

```ts
import { NotFoundError } from '../errors';
export class ProviderConnectionNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) { super(`Connection ${id} was not found`, options); this.name = 'ProviderConnectionNotFoundError'; }
}
export class RepoNotFoundError extends NotFoundError {
  constructor(id: string, options?: ErrorOptions) { super(`Repo ${id} was not found`, options); this.name = 'RepoNotFoundError'; }
}
export class OwnershipNotVerifiedError extends Error { constructor(options?: ErrorOptions) { super('Installation ownership could not be verified', options); this.name = 'OwnershipNotVerifiedError'; } }
export class ConnectStateInvalidError extends Error { constructor(msg = 'connect state invalid or expired', options?: ErrorOptions) { super(msg, options); this.name = 'ConnectStateInvalidError'; } }
```

- [ ] **Step 3: `ports.ts`** — neutral interfaces, NO vendor imports; return `@mocco/common` types:

```ts
import type { AvailableRepoDto } from '@mocco/common/integration';

export interface RepoLister {
  /** Live list of repos an installation can access (provider call). */
  listRepos(externalAccountId: string): Promise<AvailableRepoDto[]>;
}
export interface OwnershipResult { ownerVerified: boolean; accountLogin: string; githubUserId: string; }
export interface InstallationVerifier {
  /** Exchange the setup-callback OAuth `code` for a user token and confirm the caller admins `externalAccountId`. */
  verifyOwnership(code: string, externalAccountId: string): Promise<OwnershipResult>;
  /** Build the GitHub App install URL carrying our opaque `state`. */
  installUrl(state: string): string;
}
```

- [ ] **Step 4: Commit** — `feat(integration): ports, status constants, domain errors`

---

## Task 5: GitHub adapter (the vendor leaf)

**Files:** Create `domain/integration/github/provider.ts` (the ONLY `@octokit/app` importer) + `domain/integration/github/errors.ts`; Test `domain/integration/github/provider.test.ts` (pure-mapper tests only — no network).

Mirror `domain/auth/provider.ts` (factory taking config so tests can construct it; vendor isolated here). Implements `RepoLister` + `InstallationVerifier`. See spec "GitHub App tech".

- [ ] **Step 1: Failing test for the pure mapper** — `toRepo(rawInstallationRepo)` → neutral `AvailableRepoDto` (assert `defaultBranch` maps from `default_branch`, `externalRepoId` from `id`, owner/name from `full_name`/`owner.login`). This is the only unit-testable-without-network part; keep the network methods thin and covered by the router/service fakes.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Construct the `App` with a throttling+retry-plugged base Octokit. Provide `toRepo` (pure, tested), `listRepos`, `verifyOwnership`, `installUrl`. Errors translated via `github/errors.ts` (`toDomainError` reading `error.status`, never leaking the octokit object/headers). **`GITHUB_APP_SLUG` is a new env var (add it in Task 1)** so the install URL isn't a hardcoded slug that 404s.

> ⚠️ **The two network methods below are NOT covered by any unit test** (the no-mock rule replaces them with `FakeGitHubProvider` in Tasks 6/8/9). So they are **MUST-implement-correctly placeholders**, not commit-ready sketches — the only gate is the manual end-to-end check in Task 12. Verify the exact `@octokit/app` API (`getInstallationOctokit`, `app.oauth.*`, the base `Octokit` re-export path) against the INSTALLED version before writing them; the names below are indicative.

```ts
import { App } from '@octokit/app';
import { Octokit } from '@octokit/app';            // verify the exact base-Octokit re-export in the installed version
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import type { RepoLister, InstallationVerifier, OwnershipResult } from '../ports';
import type { AvailableRepoDto } from '@mocco/common/integration';

export interface GitHubConfig { appId: string; slug: string; privateKey: string; clientId: string; clientSecret: string; }

export function toRepo(raw: { id: number; name: string; default_branch: string; owner: { login: string } }): AvailableRepoDto {
  return { externalRepoId: String(raw.id), owner: raw.owner.login, name: raw.name, defaultBranch: raw.default_branch };
}

export function createGitHubProvider(config: GitHubConfig): RepoLister & InstallationVerifier {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    oauth: { clientId: config.clientId, clientSecret: config.clientSecret },
    Octokit: Octokit.plugin(throttling, retry),   // do NOT pass `undefined` — that disables the default Octokit
  });

  return {
    async listRepos(externalAccountId) {
      const octokit = await app.getInstallationOctokit(Number(externalAccountId));
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
      return data.repositories.map(toRepo);
    },
    async verifyOwnership(code, externalAccountId): Promise<OwnershipResult> {
      // 1) exchange the setup-callback `code` for a user token via app.oauth (createToken/getUserOctokit)
      // 2) with the user-scoped octokit: GET /user/installations
      // 3) ownerVerified = installations.some(i => String(i.id) === externalAccountId)
      // 4) read the user login/id from GET /user
      // return { ownerVerified, accountLogin, githubUserId }
      throw new Error('implement against the verified @octokit/app oauth API');
    },
    installUrl(state) {
      return `https://github.com/apps/${config.slug}/installations/select_target?state=${encodeURIComponent(state)}`;
    },
  };
}
export type GitHubProvider = ReturnType<typeof createGitHubProvider>;
```

Keep EVERY octokit import in THIS file (vendor isolation). `createGitHubProvider` is built in `instance.ts` (Task 7) from `getEnv()`.

- [ ] **Step 4: Run mapper test — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): GitHub adapter (octokit leaf) — listRepos, verifyOwnership, installUrl`

---

## Task 6: `ConnectionService` (+ pglite tests with fakes)

**Files:** Create `domain/integration/ConnectionService.ts`; Test `domain/integration/connection.test.ts`.

Constructor-injected `{ db, provider }`. Owns `mocco_*` tables directly (unlike auth, which goes through the vendor). Tenant-isolation invariant enforced here (spec).

**⚠️ Types (fixes review B1/B2):**
- `provider: RepoLister & InstallationVerifier` — the whole GitHub provider (used for `listRepos` in `availableRepos` and `installUrl` in `startInstall`). Tests inject a single fake implementing both. (`verifyOwnership` is also on it but is called by the ext route, not this service.)
- `db` type MUST be the shared drizzle base that both prod (`NodePgDatabase`) and pglite (`PgliteDatabase`) satisfy — use `PgDatabase<QueryResultHKT, typeof schema>` from `drizzle-orm/pg-core` (NOT the narrow `Db` from `client.ts`, which is `NodePgDatabase` only and makes the pglite test fail `ts-check`). This mirrors the known pglite+node-pg compatibility requirement.

- [ ] **Step 1: Failing tests (pglite + fake)** — inject `db` from `createTestDb()` and a `FakeGitHubProvider` (plain object implementing `RepoLister & InstallationVerifier`: `listRepos`, `installUrl`, `verifyOwnership`; no `vi.mock`). Cover:
  - `startInstall(userId, workspaceId)` → persists a `mocco_github_connect_states` row (unique `state`, `expiresAt` set) and returns `{ installUrl }` = `provider.installUrl(state)`.
  - `createConnection({ workspaceId, externalAccountId, accountLogin })` upserts on `(provider, externalAccountId)` (2nd call same account → same row id).
  - `availableRepos(workspaceId, connectionId)` returns the fake's repos; unknown/foreign-workspace connection → `ProviderConnectionNotFoundError`.
  - `addRepo(workspaceId, input)` upserts on `(connectionId, externalRepoId)`; sets `watchedBranch` (nullable); connection not in workspace → `ProviderConnectionNotFoundError`.
  - `setWatchedBranch(workspaceId, repoId, branch)` on a repo of another workspace → `RepoNotFoundError` (tenant scoping).
  - `listConnections(workspaceId)`/`listRepos(workspaceId)` scoped by `workspaceId`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the service. All read/write methods take `workspaceId` from the authed caller; **never look up a repo by `externalRepoId` alone** — always `(connection_id, external_repo_id)` and assert the resolved connection/repo `workspace_id` matches (else the `*NotFoundError`). Use drizzle `insert().onConflictDoUpdate(...)` for the upserts. `startInstall` generates an opaque `state` (`crypto.randomUUID()`), inserts the connect-state row with a short `expiresAt` (e.g. now + 10 min), returns `provider.installUrl(state)`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): ConnectionService (startInstall/connect/list/addRepo/setWatchedBranch) + pglite tests`

---

## Task 7: Composition root + Context wiring

**Files:** Create `domain/integration/instance.ts`; Modify `transport/trpc/trpc.ts` (Context), `transport/trpc/handler.ts` + `pages/api/trpc/[trpc].ts` (thread services).

- [ ] **Step 1:** `instance.ts` — mirror `auth/instance.ts` (lazy memoized). Build the GitHub provider from `getEnv()` (throw a clear domain error if the GitHub vars are absent — so a misconfigured deploy fails loudly, not at first octokit call) and `new ConnectionService({ db: getDb(), provider })`. Export `getIntegration()` → `{ connection: ConnectionService, provider }` (the `provider` is needed by the ext route for `verifyOwnership`; `connection` by both tRPC and the ext route).
- [ ] **Step 2:** Add `connection: ConnectionService` to the tRPC `Context` in `trpc.ts`. Making it a required field breaks every Context builder — update **all four sites** (Step 4's compiler will confirm, but do them deliberately):
  1. `packages/frontend/src/pages/api/trpc/[trpc].ts` — the real prod tRPC mount (`createNextApiHandler`); build Context from `getServices()` **and** `getIntegration()`.
  2. `packages/backend/src/transport/trpc/handler.ts` — `createTrpcHandler(deps)`: widen the `deps` type from `Services` to include `connection` (a `Services & { connection: ConnectionService }` or extend the interface), and set it in `createContext`. (Also fix the stale docstring claiming it's "mounted at `app/api/trpc/[trpc]/route.ts`" — prod mounts via the Pages-Router `[trpc].ts`.)
  3. `packages/backend/src/transport/trpc/root.test.ts` — the `caller(headers, session)` helper (constructs Context directly): add a `connection` built over the test pglite `db` + a `FakeGitHubProvider`.
  4. `packages/backend/src/transport/trpc/root.test.ts` — the HTTP suite's `createTrpcHandler({ auth, workspace })` call: add `connection`.
- [ ] **Step 3:** Update backend `package.json` exports: add `"./integration/instance": "./src/domain/integration/instance.ts"`. (The `"./ext/app"` export is added in Task 9 where the file is created, to keep each export with its file.)
- [ ] **Step 4: Run** `yarn backend ts-check` + `yarn backend test` — expect PASS. Fix every caller the compiler flags (should be exactly the four above).
- [ ] **Step 5: Commit** — `feat(integration): composition root + tRPC context wiring`

---

## Task 8: `integrationRouter` (tRPC internal API)

**Files:** Create `transport/trpc/routers/integration.ts`; Modify `transport/trpc/root.ts`; Test in `transport/trpc/root.test.ts` (add an integration suite).

Mirror `workspace.ts`: a router-scoped `protectedIntegrationProcedure` that maps `NotFoundError → NOT_FOUND`. Procedures thin, delegate to `ctx.connection`, `.input()`/`.output()` from `@mocco/common/integration`.

- [ ] **Step 1: Failing `createCaller` tests** — reuse the `signedInCaller` helper. Cover: `startInstall` returns an `installUrl` and persists a connect-state row; `repos` lists only the caller-workspace's repos; `addRepo` for a connection in another workspace → `NOT_FOUND`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the router:

```ts
export const integrationRouter = router({
  startInstall: protectedIntegrationProcedure
    .input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ installUrl: z.string() }))
    .mutation(async ({ ctx, input }) => ctx.connection.startInstall(ctx.session.user.id, input.workspaceId)),
  connections: protectedIntegrationProcedure.input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ connections: z.array(connectionSchema) }))
    .query(async ({ ctx, input }) => ({ connections: await ctx.connection.listConnections(input.workspaceId) })),
  availableRepos: protectedIntegrationProcedure.input(z.object({ connectionId: z.uuid(), workspaceId: z.uuid() }))
    .output(z.object({ repos: z.array(availableRepoSchema) }))
    .query(async ({ ctx, input }) => ({ repos: await ctx.connection.availableRepos(input.workspaceId, input.connectionId) })),
  repos: protectedIntegrationProcedure.input(z.object({ workspaceId: z.uuid() }))
    .output(z.object({ repos: z.array(repoSchema) }))
    .query(async ({ ctx, input }) => ({ repos: await ctx.connection.listRepos(input.workspaceId) })),
  addRepo: protectedIntegrationProcedure.input(addRepoInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ repo: repoSchema }))
    .mutation(async ({ ctx, input }) => ({ repo: await ctx.connection.addRepo(input.workspaceId, input) })),
  setWatchedBranch: protectedIntegrationProcedure.input(setWatchedBranchInputSchema.extend({ workspaceId: z.uuid() }))
    .output(z.object({ repo: repoSchema }))
    .mutation(async ({ ctx, input }) => ({ repo: await ctx.connection.setWatchedBranch(input.workspaceId, input.repoId, input.watchedBranch) })),
});
```

(`startInstall` lives on `ConnectionService` — Task 6 — which holds the injected `provider`; the router just delegates. `ctx.session.user.id` is the authed user id, `Session.user.id` shape.)

- [ ] **Step 4:** Add `integration: integrationRouter` to `root.ts`.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `feat(integration): integrationRouter (start-install/connections/repos/addRepo/setWatchedBranch)`

---

## Task 9: Hono ext surface — setup callback (backend)

**Files:** Create `transport/ext/app.ts`; Test `transport/ext/app.test.ts` (fetch `Request`/`Response`, pglite, `FakeInstallationVerifier`).

The setup callback: `GET /github/setup?installation_id=..&setup_action=install&code=..&state=..` → load session (cookie), validate + atomically consume `state`, `verifyOwnership(code, installation_id)`, persist the connection, `302 → /workspaces/<workspaceId>`.

- [ ] **Step 1: Failing tests** — build the Hono app via `createExtApp(deps)` with injected `{ auth, connection, provider }` where `provider` is a `FakeGitHubProvider` (has `verifyOwnership`) and `connection` runs over pglite `db`. Drive it with real `Request` objects (`app.request(...)` or `app.fetch(...)`). Cases: valid non-consumed state + `verifyOwnership → ownerVerified:true` → a `mocco_provider_connections` row written + `302` to `/workspaces/<workspaceId>` + the state row marked `consumedAt`; consumed/expired state → 4xx, no write; `ownerVerified:false` → 4xx, no write; `setup_action=request` (no `installation_id`) → redirect to the dashboard with a `?pending=1` flag, no connection.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** with `hono`. The setup handler: read session via the neutral `auth.getSession(headers)` surface (cookie), load+validate+atomically-consume the `state` row (scoped to the session user+workspace), call `provider.verifyOwnership(code, installation_id)`, then `connection.createConnection(...)`, then `302`. Export `createExtApp(deps)` (testable) and `extHandler(request): Promise<Response>` (prod: builds deps from `getServices()` + `getIntegration()`). The handler MUST NOT leak vendor/SQL detail on error (spec) — map to a generic message + status. Keep `hono` imports to this leaf.
- [ ] **Step 4: Add the export** to `packages/backend/package.json`: `"./ext/app": "./src/transport/ext/app.ts"`.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `feat(integration): Hono ext surface + GitHub setup callback (ownership-verified connect)`

---

## Task 10: App-Router ext route (frontend)

**Files:** Create `packages/frontend/src/app/api/ext/[[...route]]/route.ts` (first `app/` file).

- [ ] **Step 1: Implement** — delegate to the backend `extHandler` (fetch-standard), exporting `GET`/`POST` per `hono/vercel`:

```ts
import { extHandler } from '@mocco/backend/ext/app';
export const GET = (req: Request) => extHandler(req);
export const POST = (req: Request) => extHandler(req);   // POST used by the 3b webhook
```

(Or use `hono/vercel` `handle(app)` if `extHandler` is a Hono app — pick whichever the backend exports.)

The `POST` verb is wired now (the 3b webhook will add its Hono route later); for 3a the Hono app has only `GET /github/setup`, so a `POST /api/ext/github/webhook` returns a clean Hono 404 — confirm it does not surface a stack trace.

- [ ] **Step 2: Manual verify** — `yarn frontend build` succeeds with the new `app/` dir alongside `pages/` (Next 16 coexist). `yarn frontend ts-check` passes.
- [ ] **Step 3: Commit** — `feat(integration): mount ext surface on the App Router`

---

## Task 11: Frontend — Connect GitHub + repo list UI

**Files:** Modify `components/workspace-overview.tsx`, `pages/workspaces/[id]/index.tsx`; Create `components/connect-github-button.tsx`, `components/repo-list.tsx`.

Replace the disabled placeholder (`workspace-overview.tsx`) with: if no connection → a real "Connect GitHub" button (mutation `startInstall` → **full nav** `globalThis.location.assign(installUrl)`, reusing the auth-form idiom); if connected → `RepoList` (connected repos from `integration.repos`, an "Add repository" picker from `integration.availableRepos`, and a watched-branch selector per repo via `setWatchedBranch`, invalidating with `trpc.useUtils()`).

- [ ] **Step 1:** Thread `workspaceId` into `WorkspaceOverview` (page passes it, matching members/settings).
- [ ] **Step 2:** `connect-github-button.tsx` — `const { mutateAsync: startInstall, isPending } = trpc.integration.startInstall.useMutation();` on click → `const { installUrl } = await startInstall({ workspaceId }); globalThis.location.assign(installUrl);`. Use the existing `Button` (`pending` prop).
- [ ] **Step 3:** `repo-list.tsx` — `trpc.integration.repos.useQuery({ workspaceId })`, `availableRepos` picker, `addRepo`/`setWatchedBranch` mutations + `utils.integration.repos.invalidate()`. Raw `div`/`section` "cards" with the repo's `rounded-xl border border-border` style (no card primitive exists). Loading = the shared spinner span.
- [ ] **Step 4:** No new page route needed (the callback returns to `/workspaces/[id]`). If a post-install toast/flag is wanted, read a `?connected=1` query param — optional.
- [ ] **Step 5: Manual verify** — with GitHub env unset locally, the mutation surfaces a clear error (not a crash); the connected-state UI renders from seeded DB rows in a component/story or via the running app once configured.
- [ ] **Step 6: Commit** — `feat(integration): dashboard connect-GitHub + repo list/watched-branch UI`

---

## Task 12: Verify, docs, PR

- [ ] **Step 1:** `rm -rf packages/frontend/.next && yarn verify` — must be green (lint/ts/test/format/build across workspaces; pre-push enforces). Fix anything red.
- [ ] **Step 2:** Update `docs/reference/backend-conventions.md` (add the ext-surface + our-own-tables-service note) and `docs/reference/frontend-conventions.md` (the `app/` ext route coexisting with Pages Router). Keep AGENTS.md one-liners in sync.
- [ ] **Step 3:** Open the PR (base `main`, `## Why` section per pr-workflow: the problem — dashboard placeholder / no real repos; the approach — provider-adapter + ownership-verified connect; trade-offs — read-only, no sync yet). Do NOT merge (human merges).

---

## External work required from the user (call out in the PR)
- A **dev GitHub App** ("Mocco Club (dev)") is NOT needed for 3a's local test (no webhook), but the **prod app's** `GITHUB_APP_CLIENT_ID/SECRET` + "Request user authorization (OAuth) during installation" toggle + the setup URL (`https://www.mocco.club/api/ext/github/setup`, and a localhost equivalent for local install testing) must be configured by the user before the connect flow works end-to-end. 3a code + tests land without it (tests use fakes).
- Env vars (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`) in Vercel + local `.env`.
