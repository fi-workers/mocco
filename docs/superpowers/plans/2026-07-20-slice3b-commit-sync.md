# Slice 3b — Commit Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive GitHub `push` and installation-lifecycle webhooks on the ext surface, and sync a watched branch's commits into a per-repo candidate queue — verify-first, fast-ACK, deferred write — read-only and tenant-isolated.

**Architecture:** GitHub delivers to a Hono `POST /api/ext/github/webhook` (App Router). The route **verifies the HMAC signature first**, persists an idempotent delivery row, returns **202 immediately**, then runs the sync in a `@vercel/functions waitUntil()` deferred pass. `CommitSyncService` resolves `installation_id → connection → repo (by connection_id + external_repo_id)`, and upserts `mocco_commits` (natural key `(repo_id, sha)`). The GitHub adapter gains the vendor-isolated `verify`/`parseWebhook`/`listCommits`; `CommitSource` is the neutral port. Config parsing is **out of scope (3c)**.

**Tech Stack:** `@octokit/app` (installation octokit, already present), `@vercel/functions` (waitUntil), `hono` (ext surface, already present), drizzle + pglite, tRPC, zod, react-hook-form/@trpc/react-query (UI).

**Spec:** `docs/superpowers/specs/2026-07-13-slice3-github-integration-observation-design.md`. **This is one PR** (`feat/slice3b-commit-sync`, already created). Base = `main` (3a merged). `yarn verify` green before push (pre-push enforces).

## Global Constraints

- **Dependencies pinned exactly** (no `^`/`~`); `yarn.lock` holds only branch workspaces.
- **Vendor isolation:** `@octokit/*` only in `domain/integration/github/**` (lint-enforced); `hono` only in `transport/ext/**` (lint-enforced); `@vercel/functions` confined to the ext/transport leaf.
- **Repos return raw rows; narrowing happens at egress** (tRPC `.output()` strips at runtime; the service projects for the ext path). See `docs/reference/backend-conventions.md` → "Types & schemas".
- **Workspace-scoped tRPC procedures authorize the caller** via `WorkspaceService.assertMember` (the webhook is app-authenticated by HMAC, not user-scoped — different path).
- **Absolute imports only** (`@backend/*`, `@mocco/*`); **no barrels**; **constants over enums**; **env only via `getEnv()`**; **parse external data with zod `safeParse`**; every control statement braced; `return await` required.
- **No mocks / no test-only code:** integration tests run on **pglite**; network reads use injected role-interface fakes (`FakeCommitSource`); `parseWebhook`/`verify` are pure and tested against **recorded fixtures**.
- **Tenant-isolation invariant:** the ONLY resolution path is `installation_id → connection (unique) → repo by (connection_id, external_repo_id)`; never look up a repo by `external_repo_id` alone; park a webhook whose `installation_id` has no owning connection.
- **Scope boundary (do NOT build here):** no `.mocco.yml` fetch/parse (`getConfigAtCommit`, `mocco_commit_configs`) — that is 3c; no `workflow_dispatch`/execution; no durable `mocco_sync_jobs`/Cron (best-effort `waitUntil` only); no multi-branch watching; `installation_repositories` is **parse-and-log-only**.

---

## File Structure

**New files**
- `packages/common/src/integration.ts` — MODIFY: add `commitSchema`/`CommitDto`, `commitQueueItemSchema`, `commitsQueryInputSchema`, `commitsPageSchema`.
- `packages/backend/src/infra/db/schema.ts` — MODIFY: add `commits`, `webhookDeliveries` tables + a migration.
- `packages/backend/src/domain/integration/ports.ts` — MODIFY: add `CommitSource` + `SourceCommit` type.
- `packages/backend/src/domain/integration/github/webhook-events.ts` — CREATE: GitHub-namespaced zod for `push` / `installation` / `installation_repositories` (NOT neutral, NOT in `@mocco/common`) + the `ParsedWebhook` discriminated union.
- `packages/backend/src/domain/integration/github/provider.ts` — MODIFY: add `verify(rawBody, signature, secret)`, `parseWebhook(eventType, rawBody)`, `listCommits(...)`, pure `toCommit`.
- `packages/backend/src/domain/integration/github/errors.ts` — MODIFY: add `ProviderConnectionRevokedError`.
- `packages/backend/src/domain/integration/repos/commit.repo.ts` — CREATE: `CommitRepo` (upsertMany, listByRepo cursor).
- `packages/backend/src/domain/integration/repos/webhook-delivery.repo.ts` — CREATE: `WebhookDeliveryRepo` (recordIfNew).
- `packages/backend/src/domain/integration/repos/provider-connection.repo.ts` — MODIFY: add `updateStatusByExternalAccount`.
- `packages/backend/src/domain/integration/repos/repo.repo.ts` — MODIFY: add `getByConnectionAndExternalRepoId`, `inactivateByConnection`, `touchLastSynced`.
- `packages/backend/src/domain/integration/CommitSyncService.ts` — CREATE: the 3b service (sync push, backfill, lifecycle).
- `packages/backend/src/domain/integration/instance.ts` — MODIFY: build + export `commitSync`.
- `packages/backend/src/transport/ext/app.ts` — MODIFY: add `POST /github/webhook`; extend `ExtDeps`.
- `packages/backend/src/transport/trpc/routers/integration.ts` — MODIFY: add `commits` query.
- `packages/backend/src/domain/integration/testdata/*.json` — CREATE: recorded webhook fixtures (`push`, `installation.deleted`, `installation.suspend`, `installation.created`).
- `packages/frontend/src/components/commit-queue.tsx` — CREATE: candidate-queue list UI.
- `packages/frontend/src/components/repo-list.tsx` — MODIFY: surface the queue per watched repo (or link to it).
- `packages/backend/package.json`, `packages/frontend/.env.example`, `packages/backend/src/infra/config/env.ts` — MODIFY (deps/env).

**Test files** colocate as `*.test.ts` next to each unit (repo convention).

---

## Task 1: Dependencies + `GITHUB_WEBHOOK_SECRET` env

**Files:** Modify `packages/backend/package.json`, `packages/backend/src/infra/config/env.ts`, `packages/frontend/.env.example`; Test `packages/backend/src/infra/config/env.test.ts`.

**Interfaces:**
- Produces: `getEnv().GITHUB_WEBHOOK_SECRET: string | undefined`.

- [ ] **Step 1: Add the exact-pinned dep.** In `packages/backend/package.json` `dependencies`, add `@vercel/functions` at its current stable version (check npm at implementation time; no `^`/`~`). Run `yarn install` (updates `yarn.lock`).
- [ ] **Step 2: Failing env test.** In `env.test.ts` (mirror the existing PKCS#8 case — `vi.resetModules()` + dynamic `import('./env')` per case, always set `DATABASE_URL`):

```ts
it('exposes GITHUB_WEBHOOK_SECRET when set', async () => {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://x', GITHUB_WEBHOOK_SECRET: 'whsec' })) {
    vi.stubEnv(k, v);
  }
  const { getEnv } = await import('./env');
  expect(getEnv().GITHUB_WEBHOOK_SECRET).toBe('whsec');
});
```

- [ ] **Step 3: Run — expect FAIL** (`yarn backend test env`): the key is absent from the schema.
- [ ] **Step 4: Extend the zod schema** in `env.ts`: add `GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),` (optional so non-GitHub deploys still boot, consistent with the other `GITHUB_APP_*` vars). Add `GITHUB_WEBHOOK_SECRET=` to `packages/frontend/.env.example` with a one-line comment.
- [ ] **Step 5: Run — expect PASS.**
- [ ] **Step 6: Commit** — `git add packages/backend/package.json yarn.lock packages/backend/src/infra/config/env.ts packages/backend/src/infra/config/env.test.ts packages/frontend/.env.example && git commit -m "feat(integration): add @vercel/functions dep + GITHUB_WEBHOOK_SECRET env"`

---

## Task 2: Neutral `Commit` schemas (`@mocco/common`)

**Files:** Modify `packages/common/src/integration.ts`; Test `packages/common/src/integration.test.ts`.

**Interfaces:**
- Produces: `commitSchema`/`CommitDto`, `commitsQueryInputSchema`, `commitsPageSchema`.

Follow the existing shape in that file (`repoSchema`, `addRepoInputSchema`). Neutral field naming (`sha`, `authorName`, camelCase). `seq` is the opaque cursor (serialize as string — bigserial exceeds JS safe int range over time; keep it a string end-to-end).

- [ ] **Step 1: Failing test** — assert `commitSchema` round-trips a neutral commit and `commitsPageSchema` accepts `{ commits: [...], nextCursor: string | null }`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**

```ts
export const commitSchema = z.object({
  id: z.uuid(),
  repoId: z.uuid(),
  seq: z.string(), // bigserial as string (opaque cursor + monotonic sort key)
  sha: z.string(),
  branch: z.string(),
  message: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  committedAt: z.date(),
});
export type CommitDto = z.infer<typeof commitSchema>;

export const commitsQueryInputSchema = z.object({
  workspaceId: z.uuid(),
  repoId: z.uuid(),
  cursor: z.string().nullable().default(null), // seq to page before (newest-first)
  limit: z.number().int().min(1).max(50).default(20),
});
export const commitsPageSchema = z.object({
  commits: z.array(commitSchema),
  nextCursor: z.string().nullable(),
});
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(common): neutral Commit schema + candidate-queue page/query`

---

## Task 3: DB schema + migration (`mocco_commits`, `mocco_webhook_deliveries`)

**Files:** Modify `packages/backend/src/infra/db/schema.ts`; generate a migration under `packages/backend/src/infra/db/migrations/`; Test `packages/backend/src/domain/integration/commit-schema.test.ts`.

Mirror the 3a tables in the same file (uuid PK `defaultRandom()`, snake_case columns, FK `onDelete`, `uniqueIndex`, `index`).

- [ ] **Step 1: Failing pglite test** — via `createTestDb()`: insert a workspace→connection→repo, then a commit; assert (a) a 2nd commit with the same `(repo_id, sha)` upserts to one row, (b) deleting the repo cascades its commits, (c) `seq` is monotonically increasing across inserts. Separately, insert a `webhook_deliveries` row and assert a duplicate `delivery_id` is rejected.
- [ ] **Step 2: Run — FAIL** (tables don't exist).
- [ ] **Step 3: Add tables to `schema.ts`:**

```ts
export const commits = pgTable('mocco_commits', {
  id: uuid().primaryKey().defaultRandom(),
  repoId: uuid('repo_id').notNull().references(() => repos.id, { onDelete: 'cascade' }),
  seq: bigserial({ mode: 'bigint' }).notNull(),
  sha: text().notNull(),
  branch: text().notNull(),
  message: text().notNull(),
  authorName: text('author_name').notNull(),
  authorEmail: text('author_email').notNull(),
  committedAt: timestamp('committed_at').notNull(),
  syncedAt: timestamp('synced_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('mocco_commits_repo_sha_uq').on(t.repoId, t.sha),
  index('mocco_commits_repo_seq_idx').on(t.repoId, t.seq.desc()),
]);

export const webhookDeliveries = pgTable('mocco_webhook_deliveries', {
  id: uuid().primaryKey().defaultRandom(),
  provider: text().notNull(),
  deliveryId: text('delivery_id').notNull(),
  eventType: text('event_type').notNull(),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('mocco_webhook_deliveries_delivery_uq').on(t.deliveryId),
  check('mocco_webhook_deliveries_provider_check', sql`${t.provider} IN ('github')`),
]);
```

Import `bigserial` from `drizzle-orm/pg-core` if not already imported.

- [ ] **Step 4: Generate the migration** — `yarn db:generate`; inspect the SQL has the two `CREATE TABLE` + constraints; commit the generated `.sql` + `meta/` update.
- [ ] **Step 5: Run — PASS** (pglite applies the new migration via `createTestDb`).
- [ ] **Step 6: Commit** — `feat(integration): mocco_commits + mocco_webhook_deliveries tables`

---

## Task 4: `CommitSource` port + GitHub-namespaced webhook-event schema

**Files:** Modify `domain/integration/ports.ts`; Create `domain/integration/github/webhook-events.ts`. (No standalone test — exercised by adapter/service tests.)

**Interfaces:**
- Produces: `CommitSource`, `SourceCommit`; `pushEventSchema`, `installationEventSchema`, `installationRepositoriesEventSchema`, `parseWebhook`'s `ParsedWebhook` union.

- [ ] **Step 1: `ports.ts` — add the neutral port** (no vendor imports; connection referenced by `externalAccountId`, per spec "port method scoping"):

```ts
export interface SourceCommit {
  sha: string; message: string; authorName: string; authorEmail: string; committedAt: Date;
}
export interface CommitSource {
  /** Recent commits on a branch (bounded backfill). `limit` capped by the caller at BACKFILL_MAX_LIMIT. */
  listCommits(ref: { externalAccountId: string; owner: string; name: string }, branch: string, limit: number): Promise<SourceCommit[]>;
}
```

- [ ] **Step 2: `github/webhook-events.ts` — GitHub-namespaced zod** (lives next to the adapter, NOT in `@mocco/common`; only the fields we consume, `.passthrough()` tolerated). Parse with `safeParse` at the boundary:

```ts
import { z } from 'zod';

const repoRef = z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) });

export const pushEventSchema = z.object({
  ref: z.string(), // refs/heads/<branch>
  installation: z.object({ id: z.number() }),
  repository: repoRef,
  commits: z.array(z.object({
    id: z.string(), // sha
    message: z.string(),
    timestamp: z.string(),
    author: z.object({ name: z.string(), email: z.string() }),
  })),
});
export const installationEventSchema = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: z.object({ id: z.number(), account: z.object({ login: z.string(), id: z.number() }) }),
  sender: z.object({ login: z.string(), id: z.number() }),
});
export const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
});

export type ParsedWebhook =
  | { kind: 'push'; data: z.infer<typeof pushEventSchema> }
  | { kind: 'installation'; data: z.infer<typeof installationEventSchema> }
  | { kind: 'installation_repositories'; data: z.infer<typeof installationRepositoriesEventSchema> }
  | { kind: 'ignored'; eventType: string };
```

- [ ] **Step 3: Commit** — `feat(integration): CommitSource port + GitHub webhook-event schemas`

---

## Task 5: GitHub adapter — `verify`, `parseWebhook`, `listCommits`, `toCommit`

**Files:** Modify `domain/integration/github/provider.ts`, `domain/integration/github/errors.ts`; Create fixtures under `domain/integration/testdata/`; Test `domain/integration/github/provider.test.ts` (extend), `domain/integration/github/webhook.test.ts`.

Keep EVERY octokit import in `provider.ts`. `verify`/`parseWebhook`/`toCommit` are **pure** (crypto is Node built-in, allowed). Record fixtures from a real delivery once (or hand-author minimal valid payloads matching the schemas).

- [ ] **Step 1: Failing tests.**
  - `verify(rawBody, signature, secret)`: a body signed with `sha256=<hmac>` verifies true; a tampered body/signature verifies false; a malformed signature verifies false (no throw). Use a known HMAC computed in the test.
  - `parseWebhook('push', pushFixtureJson)` → `{ kind: 'push', data }` with `data.commits.length > 0`; `parseWebhook('installation', deletedFixtureJson)` → `{ kind: 'installation', data.action === 'deleted' }`; an unknown event type → `{ kind: 'ignored' }`; a body failing schema → throws a mapped domain error (not a zod dump).
  - `toCommit(pushCommit)` → `SourceCommit` (sha from `id`, `committedAt` from `timestamp`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement in `provider.ts`:**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
// ...existing imports...
import { installationEventSchema, installationRepositoriesEventSchema, pushEventSchema, type ParsedWebhook } from './webhook-events';
import type { CommitSource, SourceCommit } from '../ports';

export function verify(rawBody: string, signature: string | null, secret: string): boolean {
  if (signature === null) { return false; }
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function toSourceCommit(raw: { id: string; message: string; timestamp: string; author: { name: string; email: string } }): SourceCommit {
  return { sha: raw.id, message: raw.message, authorName: raw.author.name, authorEmail: raw.author.email, committedAt: new Date(raw.timestamp) };
}

export function parseWebhook(eventType: string | null, rawBody: string): ParsedWebhook {
  const json: unknown = JSON.parse(rawBody);
  if (eventType === 'push') { return { kind: 'push', data: pushEventSchema.parse(json) }; }
  if (eventType === 'installation') { return { kind: 'installation', data: installationEventSchema.parse(json) }; }
  if (eventType === 'installation_repositories') { return { kind: 'installation_repositories', data: installationRepositoriesEventSchema.parse(json) }; }
  return { kind: 'ignored', eventType: eventType ?? 'unknown' };
}
```

Wrap the `.parse` calls so a schema failure becomes a `GithubApiError` (or a new `WebhookParseError`) — never leak the zod issue list to the caller/GitHub.

Add `listCommits` to the returned provider object (bounded — single page, `per_page = Math.min(limit, BACKFILL_MAX_LIMIT)`, map via `toSourceCommit`-shaped `listCommits` response; note the REST `listCommits` payload nests differently from push payloads — map `commit.message`, `commit.author.{name,email,date}`, `sha`). Translate octokit failures via `github/errors.ts` (`status` only). Add `ProviderConnectionRevokedError extends` the shared base to `errors.ts` for 401/403 on a mint.

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): GitHub adapter verify/parseWebhook/listCommits (vendor leaf)`

---

## Task 6: Repos — `CommitRepo`, `WebhookDeliveryRepo` + connection/repo extensions

**Files:** Create `repos/commit.repo.ts`, `repos/webhook-delivery.repo.ts`; Modify `repos/provider-connection.repo.ts`, `repos/repo.repo.ts`; Test each `*.repo.test.ts` (pglite) or fold into the service test in Task 7 (repos are exercised there — prefer a focused repo test for the non-trivial upsert/cursor).

**Interfaces (repos return raw rows):**
- `CommitRepo.upsertMany(rows: typeof schema.commits.$inferInsert[]): Promise<void>` (on conflict `(repo_id, sha)` do nothing — commits are immutable).
- `CommitRepo.listByRepo(repoId: string, cursor: bigint | null, limit: number)` → rows `seq DESC`, `seq < cursor` when cursor set; fetch `limit + 1` to compute `nextCursor`.
- `WebhookDeliveryRepo.recordIfNew(provider, deliveryId, eventType): Promise<boolean>` (insert `onConflictDoNothing().returning()`; `true` if a row was inserted, `false` if duplicate).
- `ProviderConnectionRepo.updateStatusByExternalAccount(provider, externalAccountId, status): Promise<void>`.
- `RepoRepo.getByConnectionAndExternalRepoId(connectionId, externalRepoId)` → raw row via `getOrThrow` (throws `EntityNotFoundError`).
- `RepoRepo.inactivateByConnection(connectionId): Promise<void>` (set `status='inactive'`).
- `RepoRepo.touchLastSynced(repoId): Promise<void>`.

- [ ] **Step 1: Failing tests** covering: `recordIfNew` returns `true` then `false` for the same `delivery_id`; `upsertMany` is idempotent on `(repo_id, sha)`; `listByRepo` returns newest-first and pages by cursor; `getByConnectionAndExternalRepoId` throws for a foreign pair.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** each repo, mirroring the existing `provider-connection.repo.ts`/`repo.repo.ts` (drizzle only, `getOrThrow`/`expectOne` from `@backend/infra/db/rows`, no business logic). Use `lt(schema.commits.seq, cursor)` + `desc(schema.commits.seq)` + `.limit(limit + 1)` for the cursor page.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): commit + webhook-delivery repos; connection/repo lifecycle queries`

---

## Task 7: `CommitSyncService` (+ pglite tests with `FakeCommitSource`)

**Files:** Create `domain/integration/CommitSyncService.ts`; Test `domain/integration/commit-sync.test.ts`.

Constructor-injected `{ commits, deliveries, connections, repos, source }` (repos + the `CommitSource` port). This service owns the **tenant-isolation resolution path** and the lifecycle transitions.

**Interfaces:**
- `handle(parsed: ParsedWebhook): Promise<void>` — routes by kind; the webhook route calls this in `waitUntil`.
- `syncPush(data: PushEvent): Promise<void>` — resolve `connection = connections.findByExternalAccount('github', String(installation.id))`; if `undefined` → **park (return)**; derive `branch` from `ref` (`refs/heads/…`); resolve `repo = repos.getByConnectionAndExternalRepoId(connection.id, String(repository.id))` (throws → park/log); if `repo.watchedBranch !== branch` → skip; `commits.upsertMany(data.commits.map(toCommitRow(repo.id, branch)))`; `repos.touchLastSynced(repo.id)`.
- `backfillRepo(repo): Promise<void>` — `source.listCommits({ externalAccountId: connection.externalAccountId, owner, name }, watchedBranch, BACKFILL_DEFAULT_LIMIT)` → `upsertMany` → `touchLastSynced`. Best-effort.
- lifecycle: `handleInstallation(data)` — `deleted` → `connections.updateStatusByExternalAccount(...,'deleted')` + `repos.inactivateByConnection(conn.id)`; `suspend`/`unsuspend` → status flip; `created` → reconcile a pending connect-state (match `sender.id` to an unconsumed `mocco_github_connect_states.github_user_id` within TTL → create connection; else park unclaimed); `installation_repositories` → **log only**.

- [ ] **Step 1: Failing pglite tests** (inject `db`-backed repos + a `FakeCommitSource`):
  - push for a watched branch → commit rows written under the right repo; a second identical delivery → no duplicate rows (upsert).
  - push whose `installation_id` has no connection → **no write, no throw** (parked).
  - **Tenant isolation:** two workspaces each with a connection whose repo has the same `external_repo_id`; a push for tenant A's `installation_id` writes ONLY tenant A's repo commits (assert tenant B has zero).
  - push for a non-watched branch → skipped.
  - `installation.deleted` → connection status `deleted` + repos `inactive`; commits preserved.
  - `backfillRepo` → `FakeCommitSource` commits land; re-running is idempotent.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the service. `toCommitRow` maps `SourceCommit`/push-commit → `commits.$inferInsert` (`repoId`, `sha`, `branch`, `message`, `authorName`, `authorEmail`, `committedAt`). Resolution path is EXACTLY `installation_id → connection → repo by (connection_id, external_repo_id)` — never by `external_repo_id` alone.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): CommitSyncService — push sync, backfill, install lifecycle (tenant-isolated)`

---

## Task 8: Composition root + backfill-on-watch wiring

**Files:** Modify `domain/integration/instance.ts`, `domain/integration/ConnectionService.ts` (+ its test), `transport/trpc/routers/integration.ts`.

- [ ] **Step 1:** `instance.ts` — build `new CommitSyncService({...})` over the same `getDb()` repos + the GitHub provider (as `CommitSource`); export it from `getIntegration()` → `{ connection, provider, commitSync }`.
- [ ] **Step 2: Backfill on watch (best-effort).** In the `setWatchedBranch` tRPC resolver (integration router), after the mutation succeeds and when the new branch is non-null, fire `commitSync.backfillRepo(...)` inside `waitUntil` (import from the ext/transport boundary — keep `@vercel/functions` out of the domain). Add `commitSync` to the tRPC `Context` (like `connection`). Write a failing router test first: setting a watched branch triggers a backfill (inject a `FakeCommitSource` that records the call).
- [ ] **Step 3:** Thread `commitSync` through every Context builder the compiler flags (prod `pages/api/trpc/[trpc].ts`, `handler.ts`, `root.test.ts` caller + HTTP helper) — mirror how 3a threaded `connection`.
- [ ] **Step 4: Run** `yarn backend ts-check && yarn backend test` — PASS.
- [ ] **Step 5: Commit** — `feat(integration): wire CommitSyncService into context + backfill on watch`

---

## Task 9: Webhook route on the Hono ext surface

**Files:** Modify `transport/ext/app.ts`; Test `transport/ext/webhook.test.ts` (drive with real `Request` via `app.request`, pglite repos, recorded fixtures).

The route: `POST /github/webhook` → read the **raw** body (`await c.req.text()` — do NOT parse first, HMAC needs raw) → `verify(raw, header('x-hub-signature-256'), secret)`; invalid → `401` (no write). Valid → `recordIfNew(provider, header('x-github-delivery'), header('x-github-event'))`; duplicate → `202` (no re-process). New → return `202` **immediately**, and `waitUntil(commitSync.handle(parseWebhook(eventType, raw)))`. Never return vendor/SQL detail to GitHub.

- [ ] **Step 1: Failing tests** — extend `ExtDeps` with `{ commitSync, webhookSecret }` and a `waitUntil` injection seam (default `@vercel/functions waitUntil`, overridable in tests to run synchronously — inject it, do NOT `vi.mock`). Cases: valid signature + push fixture → `202` + commit rows written; bad signature → `401`, zero rows, no delivery row; duplicate `x-github-delivery` → `202`, no second processing; `installation.deleted` fixture → `202` + connection soft-deleted; missing secret configured → `503`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the route in `createExtApp`. Build prod deps in `extHandler` from `getServices()` + `getIntegration()` incl. `getEnv().GITHUB_WEBHOOK_SECRET` (503 if unset). Keep `hono` + `@vercel/functions` imports in this leaf only.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): GitHub webhook route — verify-first, 202, deferred sync`

---

## Task 10: tRPC `commits` query + candidate-queue UI

**Files:** Modify `transport/trpc/routers/integration.ts` (+ `root.test.ts` suite), `packages/frontend/src/components/repo-list.tsx`; Create `packages/frontend/src/components/commit-queue.tsx`.

- [ ] **Step 1: Failing router test** — `signedInCaller` + a seeded repo with commits: `integration.commits({ workspaceId, repoId, cursor: null, limit: 20 })` returns newest-first with a `nextCursor`; a non-member is `NOT_FOUND` (the workspace-scoped middleware already covers this — assert it still holds for the new procedure).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `commits: protectedIntegrationProcedure.input(commitsQueryInputSchema).output(commitsPageSchema).query(...)` delegating to a `CommitSyncService.listCommits(workspaceId, repoId, cursor, limit)` read method (which resolves the repo workspace-scoped via `RepoRepo`, then `CommitRepo.listByRepo`, and maps `seq`→string for the cursor). Serialize `seq`/`nextCursor` as strings.
- [ ] **Step 4: Run — PASS** (`yarn backend test`).
- [ ] **Step 5: Frontend** — `commit-queue.tsx`: `trpc.integration.commits.useQuery({ workspaceId, repoId })`, render rows (sha short, message, author, relative time) newest-first with a "Load more" using `nextCursor`; loading = the shared spinner; empty = a neutral empty state. Wire it into `repo-list.tsx` for watched repos (Vercel-deployments density; reuse existing `rounded-xl border border-border` card style). `yarn frontend build && yarn frontend ts-check` pass.
- [ ] **Step 6: Commit** — `feat(integration): commits query + candidate-queue UI`

---

## Task 11: Verify, docs, PR

- [ ] **Step 1:** `rm -rf packages/frontend/.next && yarn frontend build` (regenerate Next types), then `yarn verify` — must be green (format/lint/ts/test/db:drift/schema:drift/build). Fix anything red.
- [ ] **Step 2: Docs.** Update `docs/reference/backend-conventions.md` (webhook flow: verify-first → idempotent delivery → 202 → `waitUntil`; the `installation_id → connection → repo` resolution path; error hygiene to GitHub). Update `docs/reference/feature-map.md` (Commit sync → **Live**; note config parse still 3c). Add a `docs/reference/` note or extend the glossary for `mocco_commits`/candidate-queue if useful. Keep AGENTS.md one-liners in sync if a rule changed.
- [ ] **Step 3: PR** (base `main`, `## Why` per pr-workflow: problem — connected repos show no commits; approach — verify-first webhook + deferred tenant-isolated sync; trade-offs — best-effort `waitUntil` (no durable jobs), `installation_repositories` log-only, config parse deferred to 3c). Do NOT merge (human merges).

---

## External work required from the user (call out in the PR)

- **GitHub App config:** subscribe to `push`, `installation`, `installation_repositories` events; set the **webhook URL** (prod `https://www.mocco.club/api/ext/github/webhook`) and a **webhook secret**; set `GITHUB_WEBHOOK_SECRET` in Vercel + local `.env`. Keep permissions **read-only** (`Contents:read`, `Metadata:read`) — no write scopes (a CI/checklist gate asserts this).
- **Local testing (optional but expected for real deliveries):** a stable tunnel `cloudflared → hooks.mocco.club` pointing at the local Next dev server, with the App's webhook URL set to it for local installs. CI does not need the tunnel — it uses the recorded fixtures. (A fixture-replay script that POSTs signed fixtures at the local `/api/ext/github/webhook` is the fast inner loop; add it here if desired.)
- 3b code + tests land without any of the above (tests use fakes + fixtures); the live webhook only flows once the App is configured.
