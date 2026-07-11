# Slice 1 — `.mocco.yml` Define/View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user pastes a `.mocco.yml`, Mocco parses+validates it, stores it as an immutable version, and shows the parsed pipeline (name + ordered steps) in their workspace — deployed and visible on Vercel.

**Architecture:** zod in `@mocco/common` is the single type source (also generates `mocco.schema.json`). A backend `pipeline` domain parses YAML (vendor-isolated) → validates → persists `mocco_pipelines` (identity) + `mocco_pipeline_versions` (immutable snapshot, deduped by `content_hash`). A thin tRPC `pipeline` router exposes `submit/list/get`; the Pages-Router frontend follows the `account.tsx` `getServerSideProps` + vanilla-tRPC idiom.

**Tech Stack:** TypeScript, zod 4, drizzle + node-postgres (pglite in tests), tRPC, Next.js Pages Router, Playwright, `yaml`.

**Scope:** ONLY slice 1 (define/view). No runs, gates, executors, credentials, GitHub, or audit (later slices). Spec: `docs/superpowers/specs/2026-07-12-e2b-governance-roadmap-design.md` (§5/§6/§11).

**Conventions (AGENTS.md — mandatory):** zod single-source; constructor-injected service classes + composition root (`auth/instance.ts`); thin tRPC (parse→delegate, `.output()` egress); vendor isolation (one file imports `yaml`); no barrels; per-slice drizzle migration; TDD; `yarn verify` green before push; PR body with `## Summary` / `## Why` / `## Verified`. One concern → one PR; the tasks below are commits within that PR.

---

## File Structure

**Create:**
- `packages/common/src/mocco-config.ts` — v1 zod schema + inferred types (single source)
- `packages/common/src/pipeline.ts` — `PipelineDto` / `PipelineVersionDto` (wire/egress shapes)
- `packages/backend/src/pipeline/yaml/decode.ts` — the ONLY `yaml` importer (vendor boundary)
- `packages/backend/src/pipeline/errors.ts` — `MoccoConfigYamlError`, `MoccoConfigSchemaError`
- `packages/backend/src/pipeline/MoccoConfigParser.ts` — parse (decode + zod) → `ParseResult`
- `packages/backend/src/pipeline/PipelineService.ts` — `submit/list/get`
- `packages/backend/src/trpc/routers/pipeline.ts` — thin router
- `scripts/gen-mocco-schema.ts` — regenerate `mocco.schema.json` from zod (run via `tsx`)
- Frontend: `packages/frontend/src/pages/pipelines/{index,new,[id]}.tsx`, `packages/frontend/src/components/{pipeline-yaml-form,pipeline-steps}.tsx`
- `packages/e2e/tests/pipeline-define.spec.ts`

**Modify:**
- `packages/common/package.json` — add `"./mocco-config"`, `"./pipeline"` export subpaths
- `packages/backend/src/db/schema.ts` — add `pipelines`, `pipelineVersions` tables (+ `jsonb` import)
- `packages/backend/src/auth/instance.ts` — add `PipelineService` to `Services`/`getServices()`
- `packages/backend/src/trpc/trpc.ts` — add `pipeline: PipelineService` to `Context`
- **Every `Context`/`Services` construction site** — add `pipeline`: `packages/backend/src/trpc/handler.ts`, `packages/frontend/src/pages/api/trpc/[trpc].ts`, `packages/backend/src/trpc/root.test.ts` (both the `createCaller({…})` and `createTrpcHandler({…})` sites), and `packages/frontend/src/pages/account.tsx` (`appRouter.createCaller({…})`). Adding a required field to `Context`/`Services` breaks ALL construction sites' typecheck — grep for `createCaller(` and `createTrpcHandler(` to find them all.
- `packages/backend/src/trpc/root.ts` — merge `pipelineRouter`
- `package.json` (root) — `schema:gen`, `schema:drift` scripts; add `schema:drift` to `verify`
- `.github/workflows/ci.yml` — add `schema:drift` matrix leg
- `docs/reference/mocco.schema.json` — becomes generated output (narrowed to v1)
- `docs/reference/mocco-yml-spec.md` — note that gate/credential/etc. are not yet in the generated schema

---

## Task 0: Branch + `yaml` dependency

**Files:** `packages/backend/package.json`

- [ ] **Step 1: Branch from fresh main**
```bash
cd ~/Projects/fi-workers/mocco && git checkout main && git pull && git checkout -b feat/pipeline-define-view
```
- [ ] **Step 2: Add the pinned `yaml` dep** to `packages/backend/package.json` `dependencies` (alphabetical): `"yaml": "2.6.1"` (verify latest pinned with `npm view yaml version`; pin exact, no `^`).
- [ ] **Step 3: Install**
```bash
yarn install
```
Expected: adds `yaml`, `yarn.lock` updated.
- [ ] **Step 4: Commit**
```bash
git add packages/backend/package.json yarn.lock && git commit -m "chore(pipeline): add the yaml parser dependency"
```

---

## Task 1: `.mocco.yml` v1 zod schema (`@mocco/common`)

**Files:**
- Create: `packages/common/src/mocco-config.ts`
- Test: `packages/common/src/mocco-config.test.ts`
- Modify: `packages/common/package.json`

- [ ] **Step 1: Write failing tests** (`mocco-config.test.ts`) — valid config parses; each invalid class fails: wrong `version`, empty `steps`, missing `run`/`executor`, unknown top-level key (`.strict`), unknown step key (`.strict`), `with` accepts arbitrary keys, duplicate step names rejected.
```ts
import { describe, it, expect } from 'vitest';
import { moccoConfigSchema } from './mocco-config';

const valid = { version: 1, pipeline: 'deploy', steps: [{ run: 'build', executor: 'generic', with: { cmd: 'echo hi' } }] };

describe('moccoConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    expect(moccoConfigSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects version !== 1', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });
  it('rejects empty steps', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [] }).success).toBe(false);
  });
  it('rejects a step missing executor', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x' }] }).success).toBe(false);
  });
  it('rejects unknown top-level keys (strict)', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, nope: 1 }).success).toBe(false);
  });
  it('rejects unknown step keys (strict)', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x', executor: 'g', bogus: 1 }] }).success).toBe(false);
  });
  it('allows arbitrary keys inside with', () => {
    expect(moccoConfigSchema.safeParse({ ...valid, steps: [{ run: 'x', executor: 'g', with: { anything: [1, 2] } }] }).success).toBe(true);
  });
  it('rejects duplicate step names', () => {
    const dup = { ...valid, steps: [{ run: 'a', executor: 'g' }, { run: 'a', executor: 'g' }] };
    expect(moccoConfigSchema.safeParse(dup).success).toBe(false);
  });
});
```
Note: the common workspace has no `test` script yet — run these via the backend's vitest or add a `test` script to `@mocco/common`. Simplest: co-locate this schema test under backend instead (`packages/backend/src/pipeline/mocco-config.test.ts`) importing from `@mocco/common/mocco-config`, so it runs in the existing `yarn test`. **Decide: put the test in backend** to reuse the vitest runner; keep the schema in common.

- [ ] **Step 2: Run — verify it fails** (module missing)
```bash
yarn backend test 2>&1 | tail -5   # or: yarn workspace @mocco/backend test
```
Expected: FAIL (cannot resolve `@mocco/common/mocco-config`).

- [ ] **Step 3: Implement `mocco-config.ts`** (from spec §6):
```ts
import { z } from 'zod';

/** Adapter-specific options — free-form by contract (ADR 0004); the core never interprets these. */
export const stepWithSchema = z.record(z.string(), z.unknown());

/** A pipeline step. `run` is a label; `executor` is an opaque adapter id (no enum). */
export const stepSchema = z
  .object({ run: z.string().min(1), executor: z.string().min(1), with: stepWithSchema.optional() })
  .strict();
export type Step = z.infer<typeof stepSchema>;

/** A pipeline item. v1: only steps. Slice 4 widens to union(step, gate). */
export const pipelineItemSchema = stepSchema;
export type PipelineItem = z.infer<typeof pipelineItemSchema>;

export const moccoConfigSchema = z
  .object({
    version: z.literal(1),
    pipeline: z.string().min(1),
    steps: z.array(pipelineItemSchema).min(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Step names must be unique within a pipeline (runs/audit key on them).
    const seen = new Set<string>();
    cfg.steps.forEach((s, i) => {
      if (seen.has(s.run)) {
        ctx.addIssue({ code: 'custom', message: `duplicate step name "${s.run}"`, path: ['steps', i, 'run'] });
      }
      seen.add(s.run);
    });
  });
export type MoccoConfig = z.infer<typeof moccoConfigSchema>;
```

- [ ] **Step 4: Add export subpath** to `packages/common/package.json` `exports`: `"./mocco-config": "./src/mocco-config.ts"`.

- [ ] **Step 5: Run — verify pass**
```bash
yarn backend test 2>&1 | tail -5
```
Expected: PASS (8 tests).

- [ ] **Step 6: Lint + commit**
```bash
yarn lint-common && yarn lint-backend
git add packages/common/src/mocco-config.ts packages/common/package.json packages/backend/src/pipeline/mocco-config.test.ts
git commit -m "feat(common): .mocco.yml v1 schema — zod single source"
```

---

## Task 2: Generate `mocco.schema.json` from zod + drift check

**Files:** Create `scripts/gen-mocco-schema.mjs`; Modify root `package.json`, `.github/workflows/ci.yml`, `docs/reference/mocco.schema.json`, `docs/reference/mocco-yml-spec.md`.

- [ ] **Step 1: Write the generator** (`scripts/gen-mocco-schema.mjs`) — imports the zod schema, emits draft-2020-12 JSON Schema, re-attaches `$id`/`title`, writes the file. zod 4 ships `z.toJSONSchema`.
```js
import { writeFileSync } from 'node:fs';
import { moccoConfigSchema } from '../packages/common/src/mocco-config.ts';
import { z } from 'zod';

const schema = {
  $id: 'https://mocco.club/mocco.schema.json',
  title: '.mocco.yml (v1)',
  ...z.toJSONSchema(moccoConfigSchema, { target: 'draft-2020-12' }),
};
writeFileSync('docs/reference/mocco.schema.json', JSON.stringify(schema, null, 2) + '\n');
```
Run it with `tsx` (already a dev dep): `yarn tsx scripts/gen-mocco-schema.mjs` (rename to `.mjs`→`.ts` if tsx import of `.ts` needs it; simplest: `scripts/gen-mocco-schema.ts` run via `tsx`).

- [ ] **Step 2: Add root scripts** to `package.json`:
```json
"schema:gen": "tsx scripts/gen-mocco-schema.ts",
"schema:drift": "yarn schema:gen && git diff --exit-code docs/reference/mocco.schema.json"
```
And append `&& yarn schema:drift` to the `verify` script (after `db:drift`).

- [ ] **Step 3: Generate + overwrite** the committed schema (it currently is hand-written and fuller — v1 narrows it):
```bash
yarn schema:gen
```
Expected: `docs/reference/mocco.schema.json` now contains only version/pipeline/steps(run/executor/with), `additionalProperties:false`.

- [ ] **Step 4: Note the narrowing** in `docs/reference/mocco-yml-spec.md` — add a line near the top: "> ⚠️ The generated `mocco.schema.json` currently covers **v1 basics only** (version/pipeline/steps). Gates, credentials, concurrency, safety, preconditions and audit shown below are the target format and land in later slices; they are not yet in the generated schema." (The full example will not validate against the generated schema until those slices ship — intentional.)

- [ ] **Step 5: Add CI leg** — in `.github/workflows/ci.yml` matrix `step:` list, add `- schema:drift` (after `db:drift`).

- [ ] **Step 6: Verify drift passes**
```bash
yarn schema:drift
```
Expected: exit 0 (no diff after regenerate + commit).

- [ ] **Step 7: Commit**
```bash
git add scripts/gen-mocco-schema.ts package.json .github/workflows/ci.yml docs/reference/mocco.schema.json docs/reference/mocco-yml-spec.md
git commit -m "build(schema): generate mocco.schema.json from zod + drift check"
```

---

## Task 3: DB migration — `mocco_pipelines`, `mocco_pipeline_versions`

**Files:** Modify `packages/backend/src/db/schema.ts`; generate migration.

- [ ] **Step 1: Add `jsonb` to the drizzle import** in `schema.ts`: `import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex, check, jsonb } from 'drizzle-orm/pg-core';`

- [ ] **Step 2: Append the tables** (follow the existing style; `createdAt` helper is in scope):
```ts
/** A pipeline's stable identity within a workspace. */
export const pipelines = pgTable(
  'mocco_pipelines',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    // repoId lands in slice 3 (GitHub connect); pipelines are pasted/uploaded until then.
    name: text().notNull(),
    createdAt,
    updatedAt,
  },
  table => [uniqueIndex('mocco_pipelines_workspace_name_uq').on(table.workspaceId, table.name)],
);

/** An immutable snapshot of one parsed .mocco.yml. A run (later) pins one of these. */
export const pipelineVersions = pgTable(
  'mocco_pipeline_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id').notNull().references(() => pipelines.id, { onDelete: 'cascade' }),
    rawYaml: text('raw_yaml').notNull(),
    definition: jsonb().notNull(), // the parsed, zod-validated MoccoConfig
    contentHash: text('content_hash').notNull(), // sha-256 of canonical(definition)
    createdAt,
  },
  table => [
    uniqueIndex('mocco_pipeline_versions_pipeline_hash_uq').on(table.pipelineId, table.contentHash),
    index('mocco_pipeline_versions_pipeline_id_idx').on(table.pipelineId),
  ],
);
```
(Match `workspaces` reference style used by `members`/`invitations` already in the file.)

- [ ] **Step 3: Generate the migration**
```bash
yarn db:generate
```
Expected: a new `packages/backend/src/db/migrations/0003_*.sql` creating both tables.

- [ ] **Step 4: Verify drift + tests apply it**
```bash
yarn db:drift && yarn backend test 2>&1 | tail -5
```
Expected: drift clean (schema matches migration); pglite tests still green (migrations apply on fresh DB).

- [ ] **Step 5: Commit**
```bash
git add packages/backend/src/db/schema.ts packages/backend/src/db/migrations/
git commit -m "feat(db): mocco_pipelines + mocco_pipeline_versions"
```

---

## Task 4: YAML vendor boundary + `MoccoConfigParser`

**Files:** Create `pipeline/yaml/decode.ts`, `pipeline/errors.ts`, `pipeline/MoccoConfigParser.ts`, `pipeline/MoccoConfigParser.test.ts`.

- [ ] **Step 1: Write failing parser tests** — valid yaml → `{ok:true, config}`; malformed yaml → `{ok:false, stage:'yaml', issues:[{line}]}`; schema-invalid yaml → `{ok:false, stage:'schema', issues:[{path}]}`.
```ts
import { describe, it, expect } from 'vitest';
import { MoccoConfigParser } from './MoccoConfigParser';
import { decodeYaml } from './yaml/decode';

const parser = new MoccoConfigParser(decodeYaml);
const good = `version: 1
pipeline: deploy
steps:
  - run: build
    executor: generic`;

describe('MoccoConfigParser', () => {
  it('parses a valid config', () => {
    const r = parser.parse(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.pipeline).toBe('deploy');
  });
  it('reports YAML syntax errors with a line', () => {
    const r = parser.parse('version: 1\n  bad: [');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.stage).toBe('yaml'); expect(r.issues[0]?.line).toBeGreaterThan(0); }
  });
  it('reports schema errors with a path', () => {
    const r = parser.parse('version: 1\npipeline: p\nsteps: []');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.stage).toBe('schema'); expect(r.issues.some(i => i.path.startsWith('steps'))).toBe(true); }
  });
});
```

- [ ] **Step 2: Run — verify fail.** `yarn backend test 2>&1 | tail -5` → FAIL.

- [ ] **Step 3: Implement the three files.**
`yaml/decode.ts` (only `yaml` importer — vendor isolation):
```ts
import { parse as yamlParse, YAMLParseError } from 'yaml';
import { MoccoConfigYamlError } from '../errors';

/** Decode a YAML string to a plain JS value. Vendor errors → domain errors. */
export function decodeYaml(source: string): unknown {
  try {
    return yamlParse(source);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new MoccoConfigYamlError(error.message, { cause: error, line: error.linePos?.[0]?.line });
    }
    throw error;
  }
}
export type YamlDecoder = typeof decodeYaml;
```
`errors.ts`:
```ts
export class MoccoConfigYamlError extends Error {
  readonly line?: number;
  constructor(message: string, opts: { cause: unknown; line?: number }) {
    super(message, { cause: opts.cause });
    this.name = 'MoccoConfigYamlError';
    this.line = opts.line;
  }
}
export class MoccoConfigSchemaError extends Error {
  constructor(message = 'invalid .mocco.yml') { super(message); this.name = 'MoccoConfigSchemaError'; }
}
```
`MoccoConfigParser.ts` (constructor-injected decoder — no static/singleton, no *ForTesting):
```ts
import { moccoConfigSchema, type MoccoConfig } from '@mocco/common/mocco-config';
import { MoccoConfigYamlError } from './errors';
import type { YamlDecoder } from './yaml/decode';

export interface MoccoConfigIssue { path: string; message: string; code: string; line?: number }
export type ParseResult =
  | { ok: true; config: MoccoConfig }
  | { ok: false; stage: 'yaml' | 'schema'; issues: MoccoConfigIssue[] };

export class MoccoConfigParser {
  constructor(private readonly decode: YamlDecoder) {}

  parse(source: string): ParseResult {
    let value: unknown;
    try {
      value = this.decode(source);
    } catch (error) {
      if (error instanceof MoccoConfigYamlError) {
        return { ok: false, stage: 'yaml', issues: [{ path: '', message: error.message, code: 'yaml-syntax', line: error.line }] };
      }
      throw error;
    }
    const result = moccoConfigSchema.safeParse(value);
    if (result.success) return { ok: true, config: result.data };
    return {
      ok: false,
      stage: 'schema',
      issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    };
  }
}
```

- [ ] **Step 4: Run — verify pass.** `yarn backend test 2>&1 | tail -5` → PASS.
- [ ] **Step 5: Lint + commit**
```bash
yarn lint-backend
git add packages/backend/src/pipeline/
git commit -m "feat(pipeline): MoccoConfigParser + yaml vendor boundary"
```

---

## Task 5: `PipelineService` + DTOs (persist on pglite)

**Files:** Create `packages/common/src/pipeline.ts` (DTOs), `pipeline/PipelineService.ts`, `pipeline/PipelineService.test.ts`; Modify `packages/common/package.json`.

- [ ] **Step 1: DTOs** (`@mocco/common/pipeline.ts`, egress shapes for `.output()`):
```ts
import { z } from 'zod';
import { moccoConfigSchema } from './mocco-config';

export const pipelineSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.date() });
export type PipelineDto = z.infer<typeof pipelineSchema>;

export const pipelineVersionSchema = z.object({
  id: z.string(),
  definition: moccoConfigSchema, // the parsed config, re-validated at egress
  contentHash: z.string(),
  createdAt: z.date(),
});
export type PipelineVersionDto = z.infer<typeof pipelineVersionSchema>;
```
Add `"./pipeline": "./src/pipeline.ts"` to `packages/common/package.json` exports.

- [ ] **Step 2: Write failing service tests (pglite)** — `submit` creates pipeline+version; `list` returns it; `get` returns pipeline + latest version's parsed steps; **re-submitting identical yaml is idempotent** (same version, no dup); submitting invalid yaml throws a domain error; scoping is per-workspace. Use `createTestDb` (see `packages/backend/src/auth/workspace.test.ts` for the pglite pattern) and seed a workspace via the provider.
```ts
// packages/backend/src/pipeline/PipelineService.test.ts — follow the pglite + provider seeding pattern from workspace.test.ts.
// Assert: submit(ws, yaml) → {pipeline, version}; list(ws) length 1; re-submit same yaml → same version.id;
// submit(ws, 'steps: []') → throws MoccoConfigSchemaError; a second workspace sees zero pipelines.
```

- [ ] **Step 3: Run — verify fail.**
- [ ] **Step 4: Implement `PipelineService`** (constructor-injected `Db` + `MoccoConfigParser`; submit flow per spec §11):
```ts
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { pipelines, pipelineVersions } from '../db/schema';
import { MoccoConfigSchemaError } from './errors';
import type { Db } from '../db/client';
import type { MoccoConfigParser } from './MoccoConfigParser';

export class PipelineService {
  constructor(private readonly db: Db, private readonly parser: MoccoConfigParser) {}

  async submit(workspaceId: string, source: string) {
    const parsed = this.parser.parse(source);
    if (!parsed.ok) throw new MoccoConfigSchemaError(); // carry issues in the error if the router needs them
    const definition = parsed.config;
    const contentHash = createHash('sha256').update(JSON.stringify(definition)).digest('hex');

    // upsert pipeline identity by (workspace, name)
    const [pipeline] = await this.db
      .insert(pipelines)
      .values({ workspaceId, name: definition.pipeline })
      .onConflictDoUpdate({ target: [pipelines.workspaceId, pipelines.name], set: { updatedAt: new Date() } })
      .returning();

    // insert version, deduped on content_hash (idempotent re-submit)
    const [version] = await this.db
      .insert(pipelineVersions)
      .values({ workspaceId, pipelineId: pipeline!.id, rawYaml: source, definition, contentHash })
      .onConflictDoNothing({ target: [pipelineVersions.pipelineId, pipelineVersions.contentHash] })
      .returning();
    const resolvedVersion = version ?? (await this.latestVersion(pipeline!.id));
    return { pipeline: pipeline!, version: resolvedVersion };
  }

  async list(workspaceId: string) {
    return this.db.select().from(pipelines).where(eq(pipelines.workspaceId, workspaceId));
  }

  async get(workspaceId: string, id: string) {
    const [pipeline] = await this.db
      .select().from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.id, id)));
    if (!pipeline) return null;
    return { pipeline, version: await this.latestVersion(id) };
  }

  private async latestVersion(pipelineId: string) {
    const [v] = await this.db
      .select().from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, pipelineId))
      .orderBy(/* createdAt desc */);
    return v ?? null;
  }
}
```
(Fill the `orderBy(desc(pipelineVersions.createdAt))` import; adapt `.returning()` null handling to the repo's `noUncheckedIndexedAccess`.)

- [ ] **Step 5: Run — verify pass.**
- [ ] **Step 6: Lint + commit**
```bash
yarn lint-common && yarn lint-backend
git add packages/common/src/pipeline.ts packages/common/package.json packages/backend/src/pipeline/PipelineService.ts packages/backend/src/pipeline/PipelineService.test.ts
git commit -m "feat(pipeline): PipelineService submit/list/get + DTOs"
```

---

## Task 6: tRPC `pipeline` router + wiring

**Files:** Create `trpc/routers/pipeline.ts`; Modify `auth/instance.ts`, `trpc/trpc.ts`, `trpc/handler.ts`, `pages/api/trpc/[trpc].ts`, `trpc/root.ts`; test in `trpc/root.test.ts`.

- [ ] **Step 1: Wire the service into composition + context.**
  - `auth/instance.ts`: build `new PipelineService(getDb(), new MoccoConfigParser(decodeYaml))`, add `pipeline` to `Services` + `getServices()`.
  - `trpc/trpc.ts` `Context`: add `pipeline: PipelineService`.
  - Add `pipeline` to **every** context/services construction site (adding a required field breaks them all at typecheck): `trpc/handler.ts` createContext (`pipeline: deps.pipeline`), `pages/api/trpc/[trpc].ts` createContext (`pipeline` from `getServices()`), `trpc/root.test.ts` (`createCaller({…, pipeline})` at ~:33 and `createTrpcHandler({…, pipeline})` at ~:149 — construct a `PipelineService` over the test pglite `db`), and `pages/account.tsx` (`appRouter.createCaller({…, pipeline})` — pull from `getServices()` alongside the existing services). Grep `createCaller(`/`createTrpcHandler(` to confirm none are missed, then `yarn backend ts-check && yarn frontend ts-check` must be clean.

- [ ] **Step 2: Write failing router tests** in `trpc/root.test.ts` (createCaller pattern already there): authed `pipeline.submit({source})` returns `{pipeline}`; `pipeline.list` returns it; `pipeline.get({id})` returns steps; invalid source → `BAD_REQUEST`; unauthenticated → `UNAUTHORIZED`.

- [ ] **Step 3: Implement the thin router** (`trpc/routers/pipeline.ts`). `PipelineService` methods take a `workspaceId`, but the router has `ctx.workspace`/`ctx.headers`/`ctx.session`, not a bare id — so **every procedure first resolves the active workspace**: `const active = await ctx.workspace.getActive(ctx.headers); if (!active) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no active workspace' });` then call `ctx.pipeline.<method>(active.id, …)`. (`getActive` returns the org-or-null — see `WorkspaceService`/`routers/workspace.ts`.) Then: parse input with zod, delegate, `.output()` egress via the DTOs; map `MoccoConfigSchemaError`/`MoccoConfigYamlError` → `TRPCError({code:'BAD_REQUEST'})` via `instanceof` (carry `issues` in `cause`/`message`). Follow `routers/workspace.ts` shape (envelopes `{pipeline}`/`{pipelines}`/`{pipeline, version}`).

- [ ] **Step 4: Merge in `root.ts`**: `pipeline: pipelineRouter`.
- [ ] **Step 5: Run — verify pass.** `yarn backend test`.
- [ ] **Step 6: Lint + commit**
```bash
git add packages/backend/src/trpc/ packages/backend/src/auth/instance.ts packages/frontend/src/pages/api/trpc/[trpc].ts packages/frontend/src/pages/account.tsx
git commit -m "feat(trpc): pipeline router — submit/list/get"
```

---

## Task 7: Frontend — define/view pages

**Files:** Create `pages/pipelines/{index,new,[id]}.tsx`, `components/{pipeline-yaml-form,pipeline-steps}.tsx`.

> **gSSP serialization:** `getServerSideProps` props must be JSON-serializable, but the DTOs carry `createdAt: z.date()`. Map to plain-serializable props in each page (as `account.tsx` does — it passes only `id`/`name`): pass `{ id, name }` for the list, and `{ name, steps }` (+ `createdAt.toISOString()` if shown) for the detail page — never return a raw `Date` from gSSP.

- [ ] **Step 1: `pages/pipelines/index.tsx`** — `getServerSideProps` session-gate + `createCaller(ctx).pipeline.list()` (copy the `account.tsx` idiom exactly: `getServices()`, `headersFromNode`, redirect if no session); render a table of pipelines, link to `/pipelines/new` and each `/pipelines/[id]`.
- [ ] **Step 2: `pages/pipelines/new.tsx`** — renders `pipeline-yaml-form.tsx`: a `<textarea>` + submit calling `trpc.pipeline.submit.mutate({ source })`; on error render the parse issues inline (the schema error IS the UX); on success `router.push('/pipelines/[id]')`.
- [ ] **Step 3: `pages/pipelines/[id].tsx`** — `getServerSideProps` `pipeline.get({id})`; render name + `pipeline-steps.tsx` (ordered steps: `run`, `executor`, `with` keys). **Steps only** — no gate rendering (v1 has no gates).
- [ ] **Step 4: Build + lint**
```bash
yarn frontend build && yarn lint-frontend
```
Expected: compiles; lint clean (mind `set-state-in-effect`, arrow effects, `no-misused-promises` — the config already covers `pages/`/`components/`).
- [ ] **Step 5: Commit**
```bash
git add packages/frontend/src/pages/pipelines/ packages/frontend/src/components/
git commit -m "feat(frontend): pipeline define/view pages"
```

---

## Task 8: Playwright e2e

**Files:** Create `packages/e2e/tests/pipeline-define.spec.ts`.

- [ ] **Step 1: Write the spec** — reuse the sign-up + workspace-create flow from `workspace-flow.spec.ts` (a fresh user must have a workspace before defining a pipeline), then: go to `/pipelines/new`, paste a valid `.mocco.yml`, submit, assert the pipeline detail shows the pipeline name + step labels; submit an invalid yaml and assert an inline error appears.
- [ ] **Step 2: Run locally** (docker Postgres, per `make e2e`)
```bash
docker compose up -d postgres && yarn db:migrate && yarn e2e test
```
Expected: PASS.
- [ ] **Step 3: Commit**
```bash
git add packages/e2e/tests/pipeline-define.spec.ts
git commit -m "test(e2e): define + view a pipeline"
```

---

## Task 9: Full verify + PR

- [ ] **Step 1: Full mirror**
```bash
yarn verify
```
Expected: green — format, lint (incl. `schema:drift` + `lint-e2e`), 26+ tests, db:drift, build.
- [ ] **Step 2: Push + PR** (body with `## Summary` / `## Why` / `## Verified` per AGENTS.md). `## Why`: "Slice 1 of E2b — makes pipelines *real and visible* (define + view a `.mocco.yml`) before any execution/governance. Establishes the `.mocco.yml` schema (the definition source everything later builds on) as the zod single source, with the JSON Schema generated from it. Deliberately no runs/gates/credentials yet (later slices)."
- [ ] **Step 3: Wait for CI green + human merge.**

---

## Task 10: Deploy (Vercel + Supabase) — ⚠️ requires user external setup

Code lands and is unit/e2e-green independent of this; deploy needs the user.
- [ ] **User:** create the Vercel project (Root Directory `packages/frontend`; install at repo root) + a Supabase project.
- [ ] **User:** set env — `DATABASE_URL` (pooled `:6543`), `DIRECT_URL` (`:5432`), `AUTH_SECRET`, `AUTH_URL` (deployment origin). Add `DIRECT_URL` to `config/env.ts` zod + point `drizzle.config.ts` at it for migrations.
- [ ] **CI/deploy:** run `yarn db:migrate` against `DIRECT_URL` on merge to main (GitHub Action or Supabase MCP `apply_migration`) — never in the Vercel build.
- [ ] **Verify visibly running:** on the deployed URL, sign in → create workspace → paste a `.mocco.yml` → see the parsed pipeline. This is the slice-1 "complete + deployed + visible" gate.

---

## Notes for the executor
- **TDD throughout:** test → red → implement → green → commit. The repo's `verify` gates every push.
- **No barrels; explicit `exports` subpaths** for cross-package imports (`@mocco/common/mocco-config`, `@mocco/backend/...`).
- **Vendor isolation:** `yaml` is imported only in `pipeline/yaml/decode.ts`.
- **Match existing patterns:** service classes like `WorkspaceService`; router like `routers/workspace.ts`; pages like `account.tsx`; pglite tests like `workspace.test.ts`; migrations via `yarn db:generate`.
- Spec reference for any ambiguity: `docs/superpowers/specs/2026-07-12-e2b-governance-roadmap-design.md`.
