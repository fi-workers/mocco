# Env Management (SERVICE_DOMAIN + with-env loader + tailnet generator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a single canonical `SERVICE_DOMAIN` (bare authority) that the app URL + auth origins derive from; load env via an explicit two-layer `with-env` wrapper (committed `env/.env.local` → gitignored `env/.env`, which wins); and confine all Tailscale knowledge to one dev-only generator that upserts `SERVICE_DOMAIN=<tailnet host>` into `env/.env`.

**Architecture:** `SERVICE_DOMAIN` replaces `AUTH_URL` (`resolveAuthOrigins` composes the scheme: loopback→http, else https). `infra/local/scripts/with-env.ts` is a dependency-free two-file loader that `spawn`s the child with the merged env; env files live under `packages/frontend/env/` so Next's root auto-loader never sees them. `infra/local/scripts/gen-tailscale-env.ts` reads `tailscale status --json → Self.DNSName` and upserts `SERVICE_DOMAIN` into `env/.env` — the only Tailscale-aware code.

**Tech Stack:** `tsx@4.22.4` (already a root devDep), Node built-ins (`child_process`, `node:fs`), vitest for the pure parts.

**Spec:** `docs/superpowers/specs/2026-07-25-env-management-design.md`. Reference (loader shape only): `~/Projects/algocare/algocare-home/infra/local/scripts/with-env.ts`. **One chore PR** (`chore/env-management`, off `main`). `yarn verify` green before push.

## Global Constraints

- Precedence (later wins): **`env/.env.local` (committed defaults) → `env/.env` (gitignored personal)**. Two files only — no remote fetch (dropped from algocare's version).
- Env files under `packages/frontend/env/` (NOT the package root) — dodges Next's auto-loader so our precedence stands.
- **`SERVICE_DOMAIN` is a bare authority** (`host` or `host:port`), never a URL. Scheme derived in code: loopback (`localhost`/`127.*`/`[::1]`) → `http`, else `https`.
- **Tailscale is confined to `gen-tailscale-env.ts`** — `env.ts`, `origins.ts`, `with-env.ts` never reference it. They see only `SERVICE_DOMAIN`.
- Deps already present (`tsx`); no new deps; absolute imports (`@backend/*`) in product code; no barrels.
- No `vi.mock`; pure functions are exported + unit-tested, the `tailscale`/`fs`/`spawn` I/O is the untested shell.
- Env-only vars (`AUTH_SECRET`, `GITHUB_APP_*`) keep their names — only `AUTH_URL → SERVICE_DOMAIN` changes.

## File Structure

**New**
- `infra/local/scripts/with-env.ts` — two-layer loader (exports pure `parseDotenv`, `mergeEnv`).
- `infra/local/scripts/with-env.test.ts` — unit tests for the pure parts.
- `infra/local/scripts/gen-tailscale-env.ts` — tailnet host generator (exports pure `dnsNameFromStatus`, `upsertEnvLine`).
- `infra/local/scripts/gen-tailscale-env.test.ts` — unit tests for the pure parts.
- `packages/frontend/env/.env.local` — committed non-secret defaults (`SERVICE_DOMAIN=www.mocco.work`, local `DATABASE_URL`).
- `packages/frontend/env/.env.example` — template for the gitignored `env/.env`.

**Modified**
- `packages/backend/src/infra/config/env.ts` — `AUTH_URL` → `SERVICE_DOMAIN`.
- `packages/backend/src/domain/auth/origins.ts` — `authUrl` → `serviceDomain`, scheme composition.
- `packages/backend/src/domain/auth/instance.ts` — pass `serviceDomain`.
- `packages/backend/src/domain/auth/origins.test.ts` — rewrite to `serviceDomain` + a localhost case.
- `packages/e2e/playwright.config.ts` — `AUTH_URL: baseURL` → `SERVICE_DOMAIN: 'localhost:3100'`.
- `package.json` (root) — wrap `run-frontend`/`db:generate`/`db:migrate` with `with-env`; add `env:tailscale`.
- `.gitignore` — allowlist `env/.env.local` + `env/.env.example`; keep `env/.env` (+ stray root `.env*`) ignored.
- Remove `packages/frontend/.env.example` (superseded by `env/.env.example`).
- `AGENTS.md` + new `docs/reference/env.md` — the env convention.

---

## Task 1: `with-env.ts` two-layer loader + pure tests

**Files:** Create `infra/local/scripts/with-env.ts`, `infra/local/scripts/with-env.test.ts`.

Loader shape follows algocare-home's `with-env.ts` but **two files only, no remote fetch**, mocco paths (`packages/<app>/env/…`).

**Interfaces (exported for tests):**
- `parseDotenv(content: string): Record<string,string>` — trims, skips blank/`#`, splits on first `=`, strips matching surrounding quotes, keeps `=` in values.
- `mergeEnv(base, override): Record<string,string>` — `{ ...base, ...override }` (override wins).

- [ ] **Step 1: Failing tests.** `parseDotenv`: `K=V`, strips `"…"`/`'…'`, skips `#`/blank, keeps `=` in values (`K=a=b`), trims. `mergeEnv`: override beats base; a base-only key survives.
- [ ] **Step 2: Test placement — FAIL.** Add `infra/local/scripts/**/*.test.ts` (repo-root-relative) to an existing vitest project's `test.include` (prefer `packages/backend/vitest.config.ts` or `packages/common`), OR a tiny dedicated vitest project wired into a root `test-*` script. Least-friction; if none clean, colocate under `packages/common/src` importing the script by relative path — document the choice. Confirm FAIL (exports absent).
- [ ] **Step 3: Implement `with-env.ts`.**
  - `parseArgs(argv)` → `{ app, env='local', command[] }` from `--app <name> [--env <e>] -- <cmd…>`; usage error + exit 1 if missing.
  - `loadFile(path)` → `parseDotenv(readFileSync)` or `{}` if absent (warn on non-ENOENT read error).
  - `main()`: resolve `packages/<app>/env/`; `base = loadFile(.env.<env>)`; `override = loadFile(.env)`; `merged = mergeEnv(base, override)`; `spawn(command[0], command.slice(1), { stdio:'inherit', env:{...process.env, ...merged}, shell:true })`; propagate exit code; short banner (app, env, loaded counts). Export `parseDotenv`/`mergeEnv`. Dependency-free; no `Date.now`/random.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `chore(infra): with-env.ts two-layer loader (.env.local → .env)`

---

## Task 2: `gen-tailscale-env.ts` generator + pure tests

**Files:** Create `infra/local/scripts/gen-tailscale-env.ts`, `infra/local/scripts/gen-tailscale-env.test.ts`.

The ONLY Tailscale-aware code. Run on demand; writes `SERVICE_DOMAIN=<host>` into `packages/frontend/env/.env`.

**Interfaces (exported for tests):**
- `dnsNameFromStatus(json: unknown): string` — reads `Self.DNSName`, strips the trailing `.`; throws a clear Error if absent/empty.
- `upsertEnvLine(content: string, key: string, value: string): string` — replaces an existing `^<key>=` line in place, else appends `key=value` (with a trailing newline); preserves all other lines + comments.

- [ ] **Step 1: Failing tests.** `dnsNameFromStatus`: `{Self:{DNSName:'mac-mini.tailfd5d.ts.net.'}}` → `mac-mini.tailfd5d.ts.net` (dot stripped); missing/empty `Self.DNSName` → throws. `upsertEnvLine`: appends when key absent; replaces in place when present (other lines untouched, order preserved); no duplicate lines.
- [ ] **Step 2: Run — FAIL** (same vitest wiring as Task 1 picks it up).
- [ ] **Step 3: Implement `gen-tailscale-env.ts`.**
  - `readStatus()` → `execFileSync('tailscale', ['status','--json'])` → `JSON.parse`. On spawn failure (tailscale missing) → clear Error ("tailscale not found / not running").
  - `main()`: `host = dnsNameFromStatus(readStatus())`; resolve `packages/frontend/env/.env`; read existing (or `''`); `next = upsertEnvLine(existing, 'SERVICE_DOMAIN', host)`; `writeFileSync`; log `SERVICE_DOMAIN=<host> → packages/frontend/env/.env`. Non-zero exit on any thrown error (explicit dev command → fail loudly). Export the two pure fns.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `chore(infra): gen-tailscale-env.ts (upsert SERVICE_DOMAIN from tailscale Self.DNSName)`

---

## Task 3: `SERVICE_DOMAIN` product-code rename (RED→GREEN)

**Files:** Modify `env.ts`, `origins.ts`, `instance.ts`, `origins.test.ts`, `packages/e2e/playwright.config.ts`.

- [ ] **Step 1: Update the test first (RED).** Rewrite `origins.test.ts`: param `authUrl` → `serviceDomain`, values become **bare authorities** (`'www.mocco.club'`, `'mocco.work'`, `'www.mocco.work'`). Add a case: `serviceDomain: 'localhost:3100'` → `baseUrl 'http://localhost:3100'`. Preview cases keep `vercelUrl`/`vercelBranchUrl` (still https hosts) — drop the `authUrl` field there. The "no config" empty case stays. Run — FAIL (origins still takes `authUrl`).
- [ ] **Step 2: Implement.**
  - `origins.ts`: rename `AuthOriginEnv.authUrl` → `serviceDomain` (a bare authority). Add a private `schemeFor(host)` (loopback `localhost`/`127.`/`[::1]` → `http`, else `https`) and compose `const url = ${schemeFor(host)}://${serviceDomain}`; `baseUrl = new URL(url).origin`, `trustedOrigins = originVariants(url)`. Preview branch unchanged (already composes `https://${host}`). Update the doc comments (drop "AUTH_URL").
  - `env.ts`: schema key `AUTH_URL` → `SERVICE_DOMAIN` (keep `.min(1).optional()`); update the jsdoc (`Canonical app host — prod www.mocco.club, local www.mocco.work; e2e localhost:3100`).
  - `instance.ts`: `serviceDomain: env.SERVICE_DOMAIN` (was `authUrl: env.AUTH_URL`).
  - `playwright.config.ts`: `AUTH_URL: baseURL` → `SERVICE_DOMAIN: 'localhost:3100'` (leave `baseURL`/`PORT` as-is; they still describe the browser target).
- [ ] **Step 3: Run — PASS.** `yarn backend test` green; `git grep -n 'AUTH_URL\|authUrl'` returns nothing in `packages/**` src/test/config.
- [ ] **Step 4: Commit** — `refactor(auth): SERVICE_DOMAIN replaces AUTH_URL; derive scheme (loopback→http)`

---

## Task 4: Env file layout + `.gitignore`

**Files:** Create `packages/frontend/env/.env.local`, `packages/frontend/env/.env.example`; delete `packages/frontend/.env.example`; modify `.gitignore`.

- [ ] **Step 1:** Create `packages/frontend/env/.env.local` (committed, non-secret): `SERVICE_DOMAIN=www.mocco.work`, a local `DATABASE_URL` default (mirror drizzle's `postgres://mocco:mocco@localhost:5432/mocco`). No secrets.
- [ ] **Step 2:** Create `packages/frontend/env/.env.example` — template for the gitignored `env/.env`: the secrets a dev fills in (`AUTH_SECRET`, `GITHUB_APP_ID/SLUG/PRIVATE_KEY_B64/CLIENT_ID/CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `EXECUTOR_SECRET` if present on this branch) + a commented `# SERVICE_DOMAIN=<your-mac>.<tailnet>.ts.net  # or run: yarn env:tailscale`. Migrate the relevant entries from the old `packages/frontend/.env.example`.
- [ ] **Step 3:** Delete `packages/frontend/.env.example` (content now split across `env/.env.local` + `env/.env.example`).
- [ ] **Step 4:** `.gitignore` — root currently: `.env`, `.env.*`, `!.env.example`. Add explicit allowlist so BOTH `packages/frontend/env/.env.local` and `packages/frontend/env/.env.example` are tracked, while `packages/frontend/env/.env` stays ignored (and any stray root `.env*` stays ignored). Verify with `git check-ignore -v` on all three paths (`.env.local` + `.env.example` → NOT ignored; `.env` → ignored).
- [ ] **Step 5:** Confirm no `.env*` remains at `packages/frontend/` root. `git status` shows `env/.env.local` + `env/.env.example` staged, deletion of old `.env.example` staged, `env/.env` (if created) untracked.
- [ ] **Step 6: Commit** — `chore(env): move env to packages/frontend/env/ (committed .env.local + .env.example)`

---

## Task 5: Wire dev + db scripts through `with-env`

**Files:** Modify root `package.json`.

- [ ] **Step 1:** `tsx@4.22.4` is already a root devDep — no add needed (confirm).
- [ ] **Step 2:** Rewrite scripts:
  - `run-frontend`: `tsx infra/local/scripts/with-env.ts --app frontend -- yarn frontend dev` (frontend `dev` stays `next dev -p 3100`; `dev`/`concurrently` unchanged in shape).
  - `db:generate`: `tsx infra/local/scripts/with-env.ts --app frontend -- drizzle-kit generate`.
  - `db:migrate`: `tsx infra/local/scripts/with-env.ts --app frontend -- drizzle-kit migrate`.
  - Add `env:tailscale`: `tsx infra/local/scripts/gen-tailscale-env.ts`.
  - Leave `build`/`test`/`lint`/`db:drift`/`schema:*`/e2e as-is (CI/e2e supply env directly; drizzle keeps its localhost fallback).
- [ ] **Step 3: Manual verify.** `yarn db:generate` runs picking up `DATABASE_URL` from `env/.env.local` (banner prints; no "DATABASE_URL missing"). `yarn dev` boots Next on :3100 with the banner (Ctrl-C after boot). `env/.env` (if present) overrides `env/.env.local`.
- [ ] **Step 4: Commit** — `chore(scripts): run dev + drizzle through with-env; add env:tailscale`

---

## Task 6: Verify, docs, PR

- [ ] **Step 1:** `yarn verify` green. Grep for stale refs: `git grep -n 'AUTH_URL\|frontend/.env.example'` — none outside docs/changelog. Confirm moving `.env.example` broke no referenced path.
- [ ] **Step 2: Docs.** New `docs/reference/env.md`: the two file roles (`env/.env.local` committed defaults / `env/.env` gitignored personal), the precedence + why the wrapper (vs Next's inverted order), the `env/` subdir trick, `SERVICE_DOMAIN` (authority + derived scheme) as the single origin source, and the tailnet recipe (`yarn env:tailscale` → `tailscale serve` → phone on 443). Note `tailscale serve` setup is a documented manual step. Add an AGENTS.md one-liner pointing to it (and update any AGENTS.md `AUTH_URL` mention to `SERVICE_DOMAIN`).
- [ ] **Step 3: PR** (base `main`, `## Why`: env roles were mixed under Next's inverted loader and auth read a full URL; adopt a single `SERVICE_DOMAIN` (host, scheme derived) + a two-layer `with-env` loader so committed defaults vs personal overrides are separate, and confine Tailscale to one generator so product code stays provider-blind; unblocks clean per-dev tailnet access. Trade-offs: dev/db now go through the wrapper; `AUTH_URL` renamed (coordinate the run-execution branch on rebase)). Do NOT merge.

---

## Notes
- Reference `with-env.ts` (algocare-home) also does a remote bastion fetch + `apps/<app>` layout + a domain/port banner map. We take only the file-loading shape: **two files, `packages/<app>` layout, minimal banner, no fetch.**
- `AUTH_URL → SERVICE_DOMAIN` lands on `main`; the run-execution branch derives `callbackBaseUrl` via `resolveAuthOrigins`, so it picks this up on rebase — no separate change there.
- Independent of 3c (PR #72) and run-execution (local branch) — off `main`, no dependency either way.
