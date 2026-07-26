# Slice 3c — Config Parse & Commit Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For each synced commit, fetch its `.mocco.yml` at that SHA, parse it with the existing `MoccoConfigParser`, and snapshot the result into `mocco_commit_configs`; expose a commit-detail read that renders the parsed pipeline steps (or the validation errors) — read-only, tenant-isolated, best-effort deferred fetch.

**Architecture:** Extends slice 3b. `CommitSource` gains `getConfigAtCommit(ref, sha) → string | null` (the GitHub adapter reads `.mocco.yml` via `repos.getContent{ref:sha}`, base64-decoded; a `404` is a normal "no config" → `null`). A new `CommitConfigService` fetches + parses (reusing `MoccoConfigParser` + `@mocco/common/mocco-config`, both already on main) + snapshots into `mocco_commit_configs` (1:1 per commit). Snapshotting runs **inside the same deferred `waitUntil` pass** as commit sync (after commits are recorded), bounded to the just-synced batch. A tRPC `commitDetail` query is a pure DB read of the snapshot; the frontend builds a small pipeline-steps renderer (slice 1 shipped only the backend `pipeline.preview` — there is **no reusable frontend steps component on main**).

**Tech Stack:** `@octokit/app` (getContent, existing octokit leaf), drizzle + pglite, tRPC, zod, `@trpc/react-query` (UI), the existing `MoccoConfigParser`/`decodeYaml`/`mocco-config` schema.

**Spec:** `docs/superpowers/specs/2026-07-13-slice3-github-integration-observation-design.md` (slice 3c row + data model `mocco_commit_configs`). **This is one PR** (`feat/slice3c-config-detail`, already created off `main`). `yarn verify` green before push (pre-push enforces).

## Global Constraints

- **Dependencies pinned exactly** (no `^`/`~`); `yarn.lock` holds only branch workspaces.
- **Vendor isolation:** `@octokit/*` only in `domain/integration/github/**` (lint-enforced); `hono`/`@vercel/functions` only in the transport/ext leaf.
- **Repos return raw rows; narrowing happens at egress** (tRPC `.output()` strips at runtime; a service projects only for the ext path). A narrow return-type over a wide runtime object is a lie — never annotate one. See `docs/reference/backend-conventions.md` → "Types & schemas".
- **Workspace-scoped tRPC procedures authorize the caller** via `WorkspaceService.assertMember`; a repo/commit is resolved workspace-scoped (never by external id alone).
- **Absolute imports only** (`@backend/*`, `@mocco/*`); **no barrels**; **constants over enums** (reference exported constants, never raw domain strings — see `github/constants.ts`); **env only via `getEnv()`**; **parse external data with zod** (`safeParse`); every control statement braced; `return await` required.
- **No mocks / no test-only code:** integration tests run on **pglite**; network reads use an injected `FakeCommitSource` (now including `getConfigAtCommit`); no `vi.mock`, no `*ForTesting`.
- **Reuse, don't re-open:** parse via the existing `MoccoConfigParser` (`domain/pipeline/MoccoConfigParser.ts`) + `moccoConfigSchema` (`@mocco/common/mocco-config`). Do NOT re-implement `.mocco.yml` parsing or re-open the schema (ADR 0010).
- **Scope boundary (do NOT build here):** no execution/`workflow_dispatch`, no gates/approvals, no `config_hash`/`config_path` columns (dropped by spec — path is always `.mocco.yml`), no durable job table (best-effort `waitUntil`), no multi-file configs.

---

## File Structure

**New files**
- `packages/backend/src/infra/db/schema.ts` — MODIFY: add `commitConfigs` table + migration.
- `packages/common/src/integration.ts` — MODIFY: add `commitConfigSchema`/`CommitConfigDto` (raw, parsed config | null, valid, issues) + `commitDetailQueryInputSchema` / `commitDetailSchema`.
- `packages/backend/src/domain/integration/ports.ts` — MODIFY: add `getConfigAtCommit` to `CommitSource`.
- `packages/backend/src/domain/integration/github/provider.ts` — MODIFY: implement `getConfigAtCommit` (getContent, base64-decode, 404→null) in the octokit leaf.
- `packages/backend/src/domain/integration/repos/commit-config.repo.ts` — CREATE: `CommitConfigRepo` (upsert on `commit_id`, `getByCommitId`).
- `packages/backend/src/domain/integration/CommitConfigService.ts` — CREATE: snapshot (fetch→parse→upsert) + detail read.
- `packages/backend/src/domain/integration/CommitSyncService.ts` — MODIFY: after recording commits (syncPush + backfillRepo), trigger config snapshot for the batch (injected `CommitConfigService`).
- `packages/backend/src/domain/integration/instance.ts` — MODIFY: build + wire `CommitConfigService` (and inject into `CommitSyncService`).
- `packages/backend/src/transport/trpc/routers/integration.ts` — MODIFY: add `commitDetail` query.
- `packages/frontend/src/components/pipeline-steps.tsx` — CREATE: renders `MoccoConfig.steps` (run / executor / with).
- `packages/frontend/src/components/commit-detail.tsx` — CREATE: given a commitId → `integration.commitDetail` → steps (valid) or issues (invalid) or "no `.mocco.yml`".
- `packages/frontend/src/components/commit-queue.tsx` — MODIFY: select a commit → show its detail (URL-state via `searchParams`).

**Test files** colocate as `*.test.ts` next to each unit.

---

## Task 1: `getConfigAtCommit` on `CommitSource` + GitHub adapter

**Files:** Modify `ports.ts`, `github/provider.ts`; Test `github/provider.test.ts` (pure decode/404 mapping only — the network call itself has no unit test, per the no-mock rule).

**Interfaces:**
- Produces: `CommitSource.getConfigAtCommit(ref, sha): Promise<string | null>` (raw `.mocco.yml` text, or `null` when absent).

- [ ] **Step 1: Extend the port** in `ports.ts`:
```ts
export interface CommitSource {
  listCommits(ref: { externalAccountId: string; owner: string; name: string }, branch: string, limit: number): Promise<SourceCommit[]>;
  /** Raw `.mocco.yml` at a commit SHA, or null when the repo has none at that SHA (404). */
  getConfigAtCommit(ref: { externalAccountId: string; owner: string; name: string }, sha: string): Promise<string | null>;
}
```
- [ ] **Step 2: Failing test** for the pure decode/absent mapping. Factor the base64-decode + 404→null decision into a testable pure helper (e.g. `decodeContentResponse(data): string` and treat a thrown 404 as null in the method). Test: a base64 `content` payload decodes to the expected UTF-8 string; an object without `content` (e.g. a directory) is handled (throws a mapped domain error, not a crash). Keep the network `octokit.rest.repos.getContent` call itself thin.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement** in `provider.ts` (octokit leaf): `getConfigAtCommit(ref, sha)` → `getInstallationOctokit` → `rest.repos.getContent({ owner: ref.owner, repo: ref.name, path: '.mocco.yml', ref: sha })`; base64-decode `data.content`; on octokit `status === 404` return `null` (normal, NOT an error); other failures → `GithubApiError` (status only, no octokit object). Use the `.mocco.yml` path from a constant (add `CONFIG_FILE_PATH = '.mocco.yml'` to `github/constants.ts`). Add `getConfigAtCommit` to the test `FakeCommitSource`/`buildIntegration` fakes (Task 6/7 use it).
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `feat(integration): CommitSource.getConfigAtCommit — .mocco.yml at a SHA (404→null)`

---

## Task 2: DB — `mocco_commit_configs` + migration

**Files:** Modify `infra/db/schema.ts`; generate a migration; Test `domain/integration/commit-config-schema.test.ts` (pglite).

Mirror the sibling tables (uuid PK `defaultRandom()`, snake_case, FK `onDelete`, `uniqueIndex`). Per spec: `config_hash`/`config_path` are **dropped**.

- [ ] **Step 1: Failing pglite test** — seed workspace→connection→repo→commit, then a config row; assert (a) `uniqueIndex(commit_id)` rejects a 2nd config for the same commit (1:1), (b) deleting the commit cascades its config.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Add the table:**
```ts
export const commitConfigs = pgTable('mocco_commit_configs', {
  id: uuid().primaryKey().defaultRandom(),
  commitId: uuid('commit_id').notNull().references(() => commits.id, { onDelete: 'cascade' }),
  rawYaml: text('raw_yaml').notNull(),
  parsedJson: jsonb('parsed_json'),            // the parsed MoccoConfig when valid, else null
  valid: boolean().notNull(),
  validationErrors: jsonb('validation_errors').notNull().default(sql`'[]'::jsonb`),
  syncedAt: timestamp('synced_at').notNull().defaultNow(),
}, t => [uniqueIndex('mocco_commit_configs_commit_uq').on(t.commitId)]);
```
Import `jsonb`/`boolean` from `drizzle-orm/pg-core` if not present.
- [ ] **Step 4: Generate migration** — `yarn db:generate`; inspect the SQL (one CREATE TABLE + FK cascade + uniq). Commit generated files.
- [ ] **Step 5: Run — PASS** (pglite applies it via `createTestDb`).
- [ ] **Step 6: Commit** — `feat(integration): mocco_commit_configs table (1:1 per commit)`

---

## Task 3: Neutral commit-config + detail schemas (`@mocco/common`)

**Files:** Modify `packages/common/src/integration.ts`; Test `packages/common/src/integration.test.ts`.

Reuse `moccoConfigSchema` from `@mocco/common/mocco-config` for the parsed shape; reuse the issue shape used by the pipeline router (`{ path, message, code, line? }`).

- [ ] **Step 1: Failing test** — `commitDetailSchema` round-trips a valid case (`valid: true`, `config`, `issues: []`) and an invalid case (`valid: false`, `config: null`, non-empty `issues`).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:**
```ts
import { moccoConfigSchema } from './mocco-config';
export const configIssueSchema = z.object({ path: z.string(), message: z.string(), code: z.string(), line: z.number().optional() });
export const commitConfigSchema = z.object({
  present: z.boolean(),                         // false = no .mocco.yml at this commit
  valid: z.boolean(),
  config: moccoConfigSchema.nullable(),
  issues: z.array(configIssueSchema),
});
export type CommitConfigDto = z.infer<typeof commitConfigSchema>;
export const commitDetailQueryInputSchema = z.object({ workspaceId: z.uuid(), commitId: z.uuid() });
export const commitDetailSchema = z.object({ commit: commitSchema, config: commitConfigSchema.nullable() }); // config null = not yet snapshotted
export type CommitDetailDto = z.infer<typeof commitDetailSchema>;
```
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(common): commit-config + commit-detail schemas`

---

## Task 4: `CommitConfigRepo`

**Files:** Create `repos/commit-config.repo.ts`; Test `repos/commit-config.repo.test.ts` (pglite).

Mirror the sibling repos (drizzle only, `getOrThrow`/`expectOne` from `infra/db/rows`, constructor `(db)`, raw rows, `find*` never throws / `get*` throws).

**Interfaces:**
- `upsert(row: typeof schema.commitConfigs.$inferInsert): Promise<void>` (on conflict `commit_id` do update — re-snapshot overwrites).
- `findByCommitId(commitId): Promise<Row | undefined>` (never throws).

- [ ] **Step 1: Failing tests** — `upsert` is idempotent/overwrites on `commit_id`; `findByCommitId` returns raw row or undefined.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): CommitConfigRepo (upsert on commit_id, findByCommitId)`

---

## Task 5: `CommitConfigService` (+ pglite tests with `FakeCommitSource`)

**Files:** Create `domain/integration/CommitConfigService.ts`; Test `domain/integration/commit-config.test.ts`.

Constructor-injected `{ configs: CommitConfigRepo, commits: CommitRepo, repos: RepoRepo, source: CommitSource, parser: MoccoConfigParser }`. The parser is a stateless domain object (construct once at the composition root with `decodeYaml`, inject it — do NOT `new` it inside the service).

**Interfaces:**
- `snapshotCommit(ref, commitRow): Promise<void>` — `source.getConfigAtCommit(ref, commitRow.sha)`; if `null` → upsert `{ present:false, valid:false, rawYaml:'', parsedJson:null, validationErrors:[] }` (records "no config" so the detail read is a pure hit); else `parser.parse(raw)` → upsert `{ present:true, valid: result.ok, parsedJson: result.ok ? result.config : null, validationErrors: result.ok ? [] : result.issues }`. Best-effort per commit (a fetch/parse error for one commit is logged, never throws out of the batch).
- `snapshotForCommits(ref, commitRows): Promise<void>` — iterate the batch (bounded by caller; throttled by octokit plugin), calling `snapshotCommit`.
- `getDetail(workspaceId, commitId): Promise<CommitDetailDto>` — resolve the commit **workspace-scoped** (add `CommitRepo.getByIdInWorkspace(workspaceId, commitId)` mirroring `RepoRepo.getByIdInWorkspace`; maps `EntityNotFoundError` → `CommitNotFoundError` extends `NotFoundError`), then `configs.findByCommitId` → assemble the DTO (`config: null` when not yet snapshotted).

- [ ] **Step 1: Failing pglite tests** (inject db-backed repos + a `FakeCommitSource` returning canned YAML): a valid `.mocco.yml` → snapshot `valid:true` + `parsedJson` set; an invalid one → `valid:false` + `issues`; a `null` (no file) → `present:false`; `getDetail` returns the snapshot; `getDetail` for a commit in another workspace → `CommitNotFoundError`; re-snapshot overwrites (idempotent). Cover the config `present:false` path explicitly.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `NotFoundError` maps to NOT_FOUND at the router (Task 8). Keep `getConfigAtCommit` failures per-commit-isolated (log + skip that commit; the commit row already exists).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): CommitConfigService — fetch/parse/snapshot + workspace-scoped detail`

---

## Task 6: Hook config snapshot into the deferred sync pass

**Files:** Modify `CommitSyncService.ts` (+ its test).

After commits are recorded (in both `syncPush` and `backfillRepo`), snapshot their configs in the SAME deferred pass, bounded to the just-synced batch.

**Interfaces (consumes):** inject `configs: CommitConfigService` into `CommitSyncServiceDeps`.

- [ ] **Step 1: Failing test** — extend `commit-sync.test.ts`: after a push for a watched repo, the synced commits get config snapshots (assert via a `FakeCommitSource.getConfigAtCommit` returning YAML → rows in `mocco_commit_configs`). A `getConfigAtCommit` throwing for one commit does NOT fail the push (the commit rows still land; the config is just missing). Backfill path likewise snapshots.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — after `commits.upsertMany(rows)` + `touchLastSynced`, call `configs.snapshotForCommits(ref, syncedCommits)` where `ref = { externalAccountId: connection.externalAccountId, owner: repo.owner, name: repo.name }`. Wrap so a config-phase failure never breaks commit sync (config is best-effort). Do NOT re-resolve the repo — reuse what syncPush/backfillRepo already resolved.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): snapshot .mocco.yml for newly-synced commits (deferred, best-effort)`

---

## Task 7: Composition root + Context wiring

**Files:** Modify `domain/integration/instance.ts`; Modify the tRPC Context builders as the compiler flags.

- [ ] **Step 1:** In `instance.ts`, construct the parser once (`new MoccoConfigParser(decodeYaml)`), build `new CommitConfigService({ configs: new CommitConfigRepo(db), commits, repos, source: provider, parser })`, inject it into `CommitSyncService`, and add `commitConfig` to the `Integration` shape. Reuse the shared repo instances. (If touching this wiring makes the per-service dep lists unwieldy, a `buildIntegration({ db, provider })` helper shared by prod + tests is a reasonable refactor — optional, keep it minimal if done.)
- [ ] **Step 2:** Add `commitConfig: CommitConfigService` to the tRPC `Context` (mirror `commitSync`, optional-when-unconfigured). Thread it through every Context builder the compiler flags (`pages/api/trpc/[trpc].ts`, `handler.ts`, `root.test.ts` helpers) — build it over the test pglite db + `FakeCommitSource` + a real `MoccoConfigParser(decodeYaml)`.
- [ ] **Step 3: Run** `yarn backend ts-check && yarn backend test` — PASS. Fix every flagged site.
- [ ] **Step 4: Commit** — `feat(integration): wire CommitConfigService into composition root + tRPC context`

---

## Task 8: tRPC `commitDetail` query

**Files:** Modify `transport/trpc/routers/integration.ts` (+ `root.test.ts`/integration router test); add `CommitNotFoundError` to `domain/integration/errors.ts` if not added in Task 5.

- [ ] **Step 1: Failing test** — `signedInCaller` + a seeded commit with a snapshot → `integration.commitDetail({ workspaceId, commitId })` returns the commit + its config (valid/invalid/absent). A non-member → `NOT_FOUND` (the workspace-scoped middleware covers it — assert it holds). A commit in another workspace → `NOT_FOUND`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `commitDetail: protectedIntegrationProcedure.input(commitDetailQueryInputSchema).output(commitDetailSchema).query(({ ctx, input }) => ctx.commitConfig.getDetail(input.workspaceId, input.commitId))`. Ensure `CommitNotFoundError extends NotFoundError` so the router's existing `rethrowNotFound` maps it. (`commitConfig` presence — mirror how `commits`/`repos` handle `ctx.connection`/`ctx.commitSync`.)
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(integration): commitDetail query (parsed pipeline / issues, workspace-scoped)`

---

## Task 9: Frontend — pipeline-steps renderer + commit detail

**Files:** Create `packages/frontend/src/components/pipeline-steps.tsx`, `commit-detail.tsx`; Modify `commit-queue.tsx`.

Client-rendered (Pages Router), `@frontend/*` imports, shadcn/neutral tokens, React Compiler ON (no manual memo), URL-state for the selected commit (`searchParams`), jsx-a11y.

- [ ] **Step 1:** `pipeline-steps.tsx` — props `{ config: MoccoConfig }`; render `pipeline` name + an ordered list of steps (`run`, `executor`, and `with` keys if present). Pure presentational; reuse the existing card/border tokens.
- [ ] **Step 2:** `commit-detail.tsx` — `trpc.integration.commitDetail.useQuery({ workspaceId, commitId })`; states: loading (shared spinner) / not-yet-snapshotted (`config === null` → "config pending") / `present:false` ("no `.mocco.yml` at this commit") / `valid:true` (`<PipelineSteps config=… />`) / `valid:false` (render the `issues` list with path+message). 
- [ ] **Step 3:** `commit-queue.tsx` — clicking a commit sets a `?commit=<id>` search param and shows `<CommitDetail>` (panel or expand). Shareable via URL. No manual memo/callbacks.
- [ ] **Step 4: Manual verify** — `rm -rf packages/frontend/.next && yarn frontend build` + `yarn frontend ts-check` + `yarn frontend lint` clean.
- [ ] **Step 5: Commit** — `feat(integration): pipeline-steps renderer + commit detail view`

---

## Task 10: Verify, docs, PR

- [ ] **Step 1:** `rm -rf packages/frontend/.next && yarn frontend build`, then `yarn verify` — green. Fix anything red.
- [ ] **Step 2: Docs.** Update `docs/reference/backend-conventions.md` (config snapshot in the deferred pass; `getConfigAtCommit` 404→null; parse-at-sync snapshot is the audit-grade record) and `docs/reference/feature-map.md` (mark commit detail / config parse **Live**; observation slice now complete). Note reuse of `MoccoConfigParser`/`mocco-config`.
- [ ] **Step 3: PR** (base `main`, `## Why`: connected repos show commits but not what each would deploy; approach — fetch/parse/snapshot `.mocco.yml` per commit in the deferred pass + a pure-read detail view; trade-offs — best-effort per-commit fetch (throttled), snapshot overwrites on re-sync, no gates yet). Do NOT merge (human merges). Call out that slice 1 shipped only the backend `pipeline.preview`, so 3c builds the frontend steps renderer.

---

## Notes / carried context
- Slice 1 (`.mocco.yml` preview) is already on `main` (PR #27): `MoccoConfigParser`, `@mocco/common/mocco-config`, `decodeYaml`, and a backend `pipeline.preview` tRPC route — but **no frontend steps component**, so Task 9 builds it.
- 3b's `installation.created` live-reconciliation stamping is still a documented follow-up (unrelated to 3c).
- The observation slice (3a→3b→3c) is complete after this: connect → commit candidate queue → per-commit pipeline detail. Execution/gates are the next epic.
