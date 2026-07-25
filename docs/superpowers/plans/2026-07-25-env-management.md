# Env Management (with-env wrapper) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Next's built-in `.env` loading with a `with-env` wrapper giving explicit precedence — committed `env/.env.local` defaults → Tailscale team secrets (memory-only, skippable) → gitignored `env/.env` personal override (wins).

**Architecture:** A dependency-free `infra/local/scripts/with-env.ts` (ported from algocare-home) loads the files in our order + merges a runtime Tailscale fetch, then `spawn`s the child (`next dev`, `drizzle-kit`) with the merged env. Env files live in `packages/frontend/env/` so Next's root-only auto-loader never double-loads them.

**Tech Stack:** `tsx` (already used for scripts), Node built-ins (`child_process`, `fs`, `fetch`, `AbortController`), vitest for the pure parts.

**Spec:** `docs/superpowers/specs/2026-07-25-env-management-design.md`. Reference impl: `~/Projects/algocare/algocare-home/infra/local/scripts/with-env.ts`. **One chore PR** (`chore/env-management`, off `main`). `yarn verify` green before push.

## Global Constraints

- Dev-infra only — NO product code changes; `AUTH_URL`/`resolveAuthOrigins` logic untouched (this only changes how env is *loaded*).
- Precedence (later wins): **`env/.env.local` (committed defaults) → Tailscale (memory-only, configurable URL, graceful skip) → `env/.env` (gitignored personal)**.
- Env files under `packages/frontend/env/` (NOT the package root) — dodges Next's auto-loader so our precedence stands.
- Deps pinned exactly (no `^`/`~`); absolute imports where applicable; no barrels; the wrapper is dependency-free (no dotenv/dotenv-cli).
- Tailscale fetch: memory only (never written to disk), `AbortController` ~3s timeout, and **skip with a warning** when the URL is unset/non-200/unreachable — never fail the wrapped command.
- No `vi.mock`; the fetch is behind a seam so the merge tests need no network.

## File Structure

**New**
- `infra/local/scripts/with-env.ts` — the wrapper (exports pure `parseDotenv`, `mergeEnv` for tests).
- `infra/local/scripts/with-env.test.ts` — unit tests for the pure parts (or colocated where `yarn test` runs it — see Task 1).
- `packages/frontend/env/.env.local` — committed non-secret defaults.
- `packages/frontend/env/.env.example` — template for the gitignored `env/.env`.

**Modified**
- `package.json` (root) — wrap `run-frontend`, `db:generate`, `db:migrate` with `with-env`; add `tsx` if absent.
- `.gitignore` — commit `packages/frontend/env/.env.local` + `env/.env.example`; keep `env/.env` (+ stray root `.env*`) ignored.
- Remove `packages/frontend/.env.example` (superseded by `env/.env.example`).
- `AGENTS.md` + a new `docs/reference/env.md` — the env convention.

---

## Task 1: `with-env.ts` wrapper + pure-part tests

**Files:** Create `infra/local/scripts/with-env.ts`, `infra/local/scripts/with-env.test.ts`.

Port from `~/Projects/algocare/algocare-home/infra/local/scripts/with-env.ts`, adapting paths to mocco (`packages/<app>/env/…`, not `apps/<app>/env/…`) and making the Tailscale URL configurable (not the hardcoded algocare bastion).

**Interfaces (exported for tests):**
- `parseDotenv(content: string): Record<string,string>` — trims, skips blank/`#`, splits on first `=`, strips matching surrounding quotes.
- `mergeEnv(base, remote, override): Record<string,string>` — `{ ...base, ...remote, ...override }` (later wins).

- [ ] **Step 1: Failing tests.** `parseDotenv`: parses `K=V`, strips `"…"`/`'…'`, skips `#`/blank, keeps `=` in values (`K=a=b`), trims whitespace. `mergeEnv`: override beats remote beats base; a key only in base survives.
- [ ] **Step 2: Decide test placement + run — FAIL.** Place `with-env.test.ts` so root `yarn test` runs it: simplest is to add `infra/local/scripts/**/*.test.ts` to an existing vitest project's include (e.g. the backend or common vitest config's `test.include`), or a tiny dedicated vitest config wired into `test-*`. Pick the least-friction option; if none is clean, colocate under `packages/common` and import the script via relative path — document the choice. Confirm the test FAILS (module/exports absent).
- [ ] **Step 3: Implement `with-env.ts`.** Structure (mirror the reference):
  - `parseArgs(argv)` → `{ app, env='local', command[] }` from `--app <name> [--env <e>] -- <cmd…>`; usage error + exit 1 if missing.
  - `loadFile(path)` → `parseDotenv(readFileSync)` or `{}` if absent (warn on read error).
  - `fetchRemoteEnv(urlFromVars)` → if the configured URL (`MOCCO_TAILSCALE_ENV_URL`, read from the step-2 vars or `process.env`) is empty → return `{}` (skip). Else `fetch` with a 3s `AbortController` timeout; non-200 or throw → warn + `{}`. Success → `parseDotenv(text)` (memory only).
  - `main()`: resolve `packages/<app>/env/`; `base = loadFile(env/.env.<env>)`; `remote = await fetchRemoteEnv(base.MOCCO_TAILSCALE_ENV_URL ?? process.env.MOCCO_TAILSCALE_ENV_URL)`; `override = loadFile(env/.env)`; `merged = mergeEnv(base, remote, override)`; `spawn(command, { stdio:'inherit', env:{...process.env, ...merged}, shell:true })`; propagate exit code; short banner (app, env, counts). Export `parseDotenv`/`mergeEnv`.
  - Node date/random not needed. Keep it dependency-free.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `chore(infra): with-env.ts wrapper (.env.local → tailscale → .env precedence)`

---

## Task 2: Env file layout + `.gitignore`

**Files:** Create `packages/frontend/env/.env.local`, `packages/frontend/env/.env.example`; Delete `packages/frontend/.env.example`; Modify `.gitignore`.

- [ ] **Step 1:** Create `packages/frontend/env/.env.local` (committed, non-secret defaults). Migrate the non-secret defaults currently documented in `packages/frontend/.env.example`; set `AUTH_URL=https://www.mocco.work`, a local `DATABASE_URL` default, and `MOCCO_TAILSCALE_ENV_URL=` (empty → Tailscale step skips). Do NOT put any secret here.
- [ ] **Step 2:** Create `packages/frontend/env/.env.example` — the template for the gitignored `env/.env`: lists the secrets + personal overrides a dev fills in (`AUTH_SECRET`, `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`, `EXECUTOR_SECRET`, and the tailnet `AUTH_URL` override example `https://<your-mac>.<tailnet>.ts.net`). Copy the relevant entries from the old root `.env.example`.
- [ ] **Step 3:** Delete the old `packages/frontend/.env.example` (superseded — its content now split across `env/.env.local` + `env/.env.example`).
- [ ] **Step 4:** `.gitignore` — the repo currently ignores `.env` + `.env.*` (except `.env.example`). Add explicit allowlist so BOTH `packages/frontend/env/.env.local` and `packages/frontend/env/.env.example` are tracked, while `packages/frontend/env/.env` stays ignored (and any stray root `.env*` stays ignored). Verify with `git check-ignore -v` on all three paths.
- [ ] **Step 5:** Confirm no `.env*` remains at `packages/frontend/` root (so Next's auto-loader finds nothing there). `git status` shows `env/.env.local` + `env/.env.example` staged, `env/.env` (if created for testing) untracked.
- [ ] **Step 6: Commit** — `chore(env): move env to packages/frontend/env/ (committed .env.local + .env.example template)`

---

## Task 3: Wire dev + db scripts through `with-env`

**Files:** Modify root `package.json` (+ add `tsx` if absent).

- [ ] **Step 1:** Confirm `tsx` is available (root or a workspace dep). If not, add it exact-pinned to root devDependencies (`yarn add -D -W tsx@<current>`).
- [ ] **Step 2:** Wrap the scripts:
  - `run-frontend`: `tsx infra/local/scripts/with-env.ts --app frontend -- yarn frontend dev` (frontend `dev` stays `next dev -p 3100`). Root `dev` = `concurrently … yarn:run-frontend yarn:run-traefik` unchanged in shape.
  - `db:generate`: `tsx infra/local/scripts/with-env.ts --app frontend -- drizzle-kit generate`.
  - `db:migrate`: `tsx infra/local/scripts/with-env.ts --app frontend -- drizzle-kit migrate`.
  - Leave `db:drift`/`test`/`lint`/`build` as-is (they don't need the layered env, or CI supplies env directly).
- [ ] **Step 3: Manual verify** — `yarn db:generate` runs and picks up `DATABASE_URL` from `env/.env.local` (banner prints; no "DATABASE_URL missing"); `yarn dev` boots Next on :3100 with the banner showing loaded counts (Ctrl-C after boot). If the Tailscale URL is empty, the banner/logs show the fetch skipped (not an error).
- [ ] **Step 4: Commit** — `chore(scripts): run dev + drizzle through with-env`

---

## Task 4: Verify, docs, PR

- [ ] **Step 1:** `yarn verify` — must stay green (the wrapper doesn't touch verify's steps; confirm nothing regressed, esp. that moving `.env.example` didn't break any path that referenced the old location — grep for `.env.example` / `frontend/.env`).
- [ ] **Step 2: Docs.** New `docs/reference/env.md`: the three roles (`env/.env.local` committed defaults / Tailscale team secrets memory-only / `env/.env` gitignored personal), the precedence + why the wrapper (vs Next's inverted order), the `env/` subdir trick, and the tailnet `AUTH_URL`-override recipe (method A: `tailscale serve` + personal `env/.env`). Note the Tailscale endpoint is a pending ops task (URL unset → skip). Add an AGENTS.md one-liner pointing to it.
- [ ] **Step 3: PR** (base `main`, `## Why`: env roles were mixed under Next's loader; adopt algocare-home's proven with-env precedence so committed defaults / team secrets / personal overrides are separate; unblocks clean per-dev tailnet `AUTH_URL`. Trade-offs: Tailscale fetch is wired but its endpoint is a later ops task (skips until set); dev/db now go through the wrapper). Do NOT merge.

---

## Notes
- Reference `with-env.ts` (algocare-home) hardcodes its bastion URL + an `apps/<app>` layout and prints a domain/port banner map. Adapt: configurable URL, `packages/<app>` layout, a minimal banner. Don't copy the algocare domain/port maps.
- This is independent of 3c (PR #72) and run-execution (local branch) — off `main`, no dependency either way.
