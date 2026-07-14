# Backend `#backend` Absolute Imports Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@mocco/backend` a named, backend-internal absolute-import prefix `#backend/*` (Node subpath imports), convert all `../` parent imports to it, and lint-enforce no parent climbs — mirroring the frontend `@/` decision (#52) but via package.json `imports` so it survives Next/vitest/tsc resolution without touching the locked `exports` contract.

**Architecture:** Add `"imports": { "#backend/*": "./src/*" }` to `packages/backend/package.json`. Node subpath imports resolve natively in every toolchain (tsc `moduleResolution: Bundler`, Next/webpack via `transpilePackages`, vitest/Vite). No tsconfig `paths`, no vitest plugin, no cross-package mapping. Then a mechanical sweep of 24 files converts `from '../…'` → `from '#backend/…'`, and an eslint block bans `^\.\./`.

**Tech Stack:** TypeScript 5.9.3, Node subpath imports, ESLint 10 flat config, Next 16 (Turbopack), vitest 4.

**Precursor role:** This PR must merge to `main` before the repository-layer refactor (`2026-07-15-db-repository-layer.md`) rebases onto it and writes new repo files with `#backend/` imports. Separate PR off `main`; do NOT fold into #68.

---

## Scope

- **In:** `packages/backend/` only — `package.json` (`imports` field), `eslint.config.mjs` (parent-import ban), and the 24 `src/**/*.ts` files that currently use `from '../…'`.
- **Out:** frontend `@/` (unchanged), `@mocco/common` cross-package imports (unchanged), same-directory `./` sibling imports (unchanged — they survive a file moving within its folder), the repository refactor (separate plan).

## The 24 files to sweep

`domain/auth/{auth.test,errors,instance,provider,workspace.test}.ts`,
`domain/integration/{connection.test,ConnectionService,errors,instance,schema.test}.ts`,
`domain/integration/github/provider.ts`, `domain/pipeline/yaml/decode.ts`,
`infra/db/{client,testing/pglite}.ts`, `transport/ext/{app.test,app}.ts`,
`transport/trpc/{handler,root.test,trpc}.ts`,
`transport/trpc/routers/{debug,integration.test,integration,pipeline,workspace}.ts`.

---

### Task 1: Add the `#backend` subpath import + prove it resolves in all three toolchains

**This is the risk gate.** Node subpath imports are standard, but confirm Next's bundler, vitest, and tsc all resolve `#backend/*` in THIS repo before doing the sweep. If any fail, STOP and use the Fallback below.

**Files:**
- Modify: `packages/backend/package.json` (add `imports`)
- Modify (canary, reverted in Step 5): one existing file, e.g. `packages/backend/src/transport/trpc/trpc.ts`

- [ ] **Step 1: Add the `imports` field**

In `packages/backend/package.json`, add a top-level `"imports"` key (sibling of `"exports"`):

```jsonc
"imports": {
  "#backend/*": "./src/*"
},
```

- [ ] **Step 2: Convert ONE import as a canary**

Pick a file that imports a parent path AND is reachable from a public `exports` entry (so the Next build exercises it). `transport/trpc/trpc.ts` is imported by `trpc/root` (public). Change its `from '../…'` import(s) to `from '#backend/…'` (full path from `src/`, e.g. `../infra/config/env` → `#backend/infra/config/env`).

- [ ] **Step 3: Verify tsc + vitest resolve it**

Run: `yarn workspace @mocco/backend ts-check && yarn workspace @mocco/backend test`
Expected: PASS (types resolve, all tests green). A resolution failure prints `Cannot find module '#backend/...'`.

- [ ] **Step 4: Verify the Next bundler resolves it**

Run: `yarn workspace @mocco/frontend build`
Expected: build SUCCEEDS. `trpc.ts` is pulled in transitively via `@mocco/backend/trpc/root`, so a Turbopack failure to resolve `#backend/*` surfaces here. (This is the one uncertain resolver — `transpilePackages` already covers `@mocco/backend`, and Node subpath imports are resolved from the importing module's own package.json, which is backend's.)

> **Fallback (only if Step 3 or 4 fails):** Do NOT expand `exports` with a wildcard (breaks the locked public contract). Instead abandon the alias for this refactor and keep relative imports repo-wide (the repository refactor then uses `../` like the rest); reopen the naming decision with the user. Record the failure mode in the plan before stopping.

- [ ] **Step 5: Revert the canary, commit the `imports` field alone**

Revert `trpc.ts` to `../` (the full sweep happens in Task 3, kept separate so a resolution problem isn't entangled with 24 files).

```bash
git checkout -- packages/backend/src/transport/trpc/trpc.ts
git add packages/backend/package.json
git commit -m "chore(backend): add #backend/* subpath import (internal absolute path)"
```

---

### Task 2: Lint-ban parent (`../`) imports in the backend

**Files:**
- Modify: `packages/backend/eslint.config.mjs`

- [ ] **Step 1: Add the parent-import ban**

The backend already has a `no-restricted-imports` block scoped to `files: ['**/*.ts'], ignores: ['src/domain/auth/**']` for vendor isolation. `no-restricted-imports` arrays do NOT merge across flat-config objects, so add the `^\.\./` regex pattern **into that existing block's `patterns` array** (alongside the two vendor patterns) rather than a new block — otherwise one rule silently overrides the other. Mirror the frontend message (`eslint.config.mjs` #52):

```js
{
  regex: '^\\.\\./',
  message: 'Use the #backend/* absolute import instead of a ../ parent climb (same-dir ./ is fine).',
},
```

The `ignores: ['src/domain/auth/**']` on that block means auth files won't get the ban from THIS block. Auth still has `../` imports (5 files) that need banning too — since auth is excluded from the vendor block, add the parent-import ban for auth in a **separate small block** scoped `files: ['src/domain/auth/**/*.ts']` with just the `^\.\./` pattern. (Do not add the vendor patterns there — auth is the vendor boundary and legitimately imports `./provider`.)

- [ ] **Step 2: Verify the ban fires (and nothing else is broken yet)**

Run: `yarn workspace @mocco/backend lint`
Expected: FAILS with many `no-restricted-imports` errors on `../` lines across the 24 files — this proves the rule is active. (Task 3 fixes them all.)

- [ ] **Step 3: Do NOT commit yet** — the lint is red until Task 3 converts the imports. Task 2 + Task 3 land in one commit.

---

### Task 3: Sweep all 24 files `../` → `#backend/`

**Files:** the 24 files listed under Scope.

- [ ] **Step 1: Convert every parent import**

For each file, rewrite `from '../…'` (any number of `../`) to `from '#backend/<path-from-src>'`. The target is always the path relative to `packages/backend/src/`. Examples:
- `domain/integration/ConnectionService.ts`: `from '../../infra/db/schema'` → `from '#backend/infra/db/schema'`; `from '../errors'` → `from '#backend/domain/errors'`? **NO** — `../errors` from `domain/integration/` resolves to `domain/errors`, so `#backend/domain/errors`. Compute each target from the file's own directory. Leave `./errors` (same-dir) and `@mocco/common/*` untouched.
- `infra/db/client.ts`: `from '../config/env'` → `#backend/infra/config/env`.

Keep import ordering valid (`import-x/order` is enforced) — `#backend/*` is an internal alias; run the auto-fixer to reorder.

- [ ] **Step 2: Auto-fix ordering/format**

Run: `yarn workspace @mocco/backend lint --fix`
Then re-run: `yarn workspace @mocco/backend lint`
Expected: PASS (0 errors — no `../` remain, ordering fixed).

- [ ] **Step 3: Typecheck + tests + build all green**

Run: `yarn verify`
Expected: PASS — ts-check, lint (all packages), tests, drift gates. Then `yarn workspace @mocco/frontend build` → SUCCESS.

- [ ] **Step 4: Commit the ban + sweep together**

```bash
git add packages/backend/eslint.config.mjs packages/backend/src
git commit -m "refactor(backend): convert ../ imports to #backend/*; lint-ban parent climbs"
```

---

### Task 4: Docs + open the PR

**Files:**
- Modify: `AGENTS.md` (note the backend `#backend/*` convention beside the env/vendor rules)
- Modify: `docs/reference/backend-conventions.md` (one line)

- [ ] **Step 1: Document the convention**

Add to AGENTS.md Code-style: backend uses `#backend/*` (Node subpath imports) for cross-directory imports; same-dir `./` stays relative; cross-package stays `@mocco/common/*`; `../` parent climbs are lint-banned. Mirror in backend-conventions.md.

- [ ] **Step 2: Verify + commit**

Run: `yarn verify`
Expected: PASS.

```bash
git add AGENTS.md docs/reference/backend-conventions.md
git commit -m "docs: backend uses #backend/* internal absolute imports"
```

- [ ] **Step 3: Push + open PR off `main`**

```bash
git push -u origin chore/backend-hash-imports
gh pr create --base main --title "chore(backend): #backend/* internal absolute imports" --body "<## Why: mirror the frontend @/ decision (#52) for the backend, via Node subpath imports so it survives Next/vitest/tsc without touching the locked exports contract. Precursor to the repository-layer refactor. Benefit/tradeoffs per /pr shape.>"
```

- [ ] **Step 4: Hand off** — human merges. The repository-layer plan rebases #68 onto the new `main` afterward.

---

## Verification (whole plan)

- `yarn verify` green (all packages: ts-check, lint, tests, drift).
- `yarn workspace @mocco/frontend build` succeeds (Next/Turbopack resolves `#backend/*`).
- `grep -rE "from '\\.\\./" packages/backend/src` returns nothing.
- eslint fails a scratch `../` import (rule active).
