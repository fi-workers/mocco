---
title: Env management — SERVICE_DOMAIN + with-env loader + tailnet generator (design)
description: Introduce a single canonical SERVICE_DOMAIN (bare host) that the app URL and auth origins derive from (always https); load env via an explicit two-layer with-env wrapper (committed env/.env.local defaults → gitignored env/.env personal override, which wins); and confine all Tailscale knowledge to one dev-only generator that writes SERVICE_DOMAIN=<tailnet host> into env/.env. Product code and the loader never know Tailscale exists.
type: design
status: active
created: 2026-07-25
owner: andrea
related:
  - ../../adr/0005-tech-stack-vercel-native-next-fullstack.md
  - ../../adr/0006-domains-mocco-club-prod-mocco-work-local.md
---

# Env management — `SERVICE_DOMAIN` + `with-env` loader + tailnet generator

> A dev-infra chore with one small product-code change. Today mocco leans on Next's built-in `.env` loading (whose `.env.local` > `.env` precedence mixes committed shared config with personal values), and auth reads a full `AUTH_URL` directly. Replace this with: **(1)** a single canonical `SERVICE_DOMAIN` (bare host) that the app URL + auth origins derive from, **(2)** an explicit two-layer `with-env` loader, and **(3)** a dev-only generator that writes the tailnet host into `SERVICE_DOMAIN`. Off `main`, its own chore PR.

## Core principle

**Tailscale is a developer-machine concern, confined to ONE generator script. Nothing else knows it exists** — not the loader, not `env.ts`, not `resolveAuthOrigins`. They all see only `SERVICE_DOMAIN`, an ordinary env var. Swapping tailnet access for a real domain, ngrok, or localhost is just a different `SERVICE_DOMAIN` — no code changes anywhere.

## The three pieces

### 1. `SERVICE_DOMAIN` — the canonical app host (product code)

One env var answers "what host is this app served at?" — a **bare host**, no scheme, no path (e.g. `www.mocco.work`, `mac-mini.tailfd5d.ts.net`). Everything origin-dependent derives from it, always over **https** (every real environment terminates TLS on 443 — traefik+mkcert locally, `tailscale serve` on the tailnet, the platform in prod/preview):

- `resolveAuthOrigins` takes `serviceDomain` (renamed from `authUrl`) and derives `baseUrl = https://${serviceDomain}` + `trustedOrigins` from it.
- run-execution's `callbackBaseUrl` derives from the same (it already flows through `resolveAuthOrigins`).
- **`AUTH_URL` is removed** — `SERVICE_DOMAIN` replaces it. `AUTH_SECRET`, `GITHUB_APP_*`, etc. are unchanged (they're secrets, not the host).

Per-environment values (set in env files, never in code):
- local default: `SERVICE_DOMAIN=www.mocco.work` (committed in `env/.env.local`)
- tailnet: `SERVICE_DOMAIN=<node>.<tailnet>.ts.net` (written by the generator into `env/.env`)
- prod: `SERVICE_DOMAIN=www.mocco.club`
- preview: derived from `VERCEL_URL` (already a bare host → same `https://${host}` path; existing logic, re-pointed to compose from the host)

### 2. `with-env` — a generic two-layer loader (no Tailscale, no remote fetch)

`infra/local/scripts/with-env.ts` loads env files in OUR precedence and execs the child (`next dev`, `drizzle-kit`) with the merged env:

1. Parse `--app <name> [--env <environment>] -- <command…>` (default env `local`).
2. Load `packages/<app>/env/.env.<environment>` (committed defaults; `.env.local` for env `local`) via a tiny dependency-free dotenv parser (quotes stripped, `#`/blank skipped, first `=` split).
3. Load `packages/<app>/env/.env` (gitignored personal override).
4. Merge `{ ...defaults, ...personal }` (personal wins) and `spawn` the command with `{ ...process.env, ...merged }`, `{ stdio: 'inherit', shell: true }`, propagating the exit code. Short banner (app, env, loaded counts).

**Key trick:** env files live in a `env/` subdirectory (`packages/frontend/env/`), which Next's root-only auto-loader never sees — so our precedence stands and there's no double-load. The loader is deliberately dumb: two files, later wins. The tailnet value is already a plain line in `.env` by the time the loader runs, so the loader needs no Tailscale awareness. (This is a deliberate simplification of algocare-home's `with-env.ts`, which also does a remote bastion fetch — we drop that middle step.)

### 3. `gen-tailscale-env` — the tailnet host generator (the only Tailscale-aware code)

`infra/local/scripts/gen-tailscale-env.ts`, run on demand (`yarn env:tailscale`):

1. Read this machine's MagicDNS name from `tailscale status --json` → `.Self.DNSName`, strip the trailing `.` → e.g. `mac-mini.tailfd5d.ts.net`. **Account-agnostic:** reads whatever the currently-active tailnet node is, so it adapts to any logged-in account/machine — the host is never hardcoded.
2. **Upsert** `SERVICE_DOMAIN=<host>` into `packages/frontend/env/.env` (gitignored personal file): replace an existing `SERVICE_DOMAIN=` line in place, else append; preserve all other lines. (A bare host — no `https://`, code adds the scheme.)
3. If `tailscale` is missing or not up (`Self.DNSName` absent) → a clear error + non-zero exit. It's an explicit dev command, so failing loudly is correct.

The pure upsert (`upsertEnvLine(content, key, value)`) and the `Self.DNSName` extraction (`dnsNameFromStatus(json)`) are exported and unit-tested; the `tailscale`/`fs` calls are the untested I/O shell.

`tailscale serve` (the 443 exposure that makes `https://<node>.ts.net` actually reachable) is a separate runtime step — documented, not part of this generator. The generator only produces the env value.

## Env file layout (new `packages/frontend/env/`)

- `env/.env.local` — committed defaults (`SERVICE_DOMAIN=www.mocco.work`, a local `DATABASE_URL` default). No secrets.
- `env/.env.example` — template documenting what a dev puts in `env/.env` (secrets + personal overrides: `AUTH_SECRET`, `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`, `EXECUTOR_SECRET`, and a commented `SERVICE_DOMAIN` tailnet-override example).
- `env/.env` — **gitignored**, developer-created / generator-written.
- Remove the old root `packages/frontend/.env.example` (superseded).
- `.gitignore` — currently ignores `.env` + `.env.*` (except `.env.example`). Adjust so `env/.env.local` and `env/.env.example` are **committed**, while `env/.env` (and any stray root `.env*`) stay ignored (explicit allowlist entries + verified with `git check-ignore -v`).

## Script wiring (root `package.json`)

- `run-frontend`: `tsx infra/local/scripts/with-env.ts --app frontend -- yarn frontend dev` (frontend `dev` stays `next dev -p 3100`). `dev` (concurrently) unchanged in shape.
- `db:generate` / `db:migrate`: wrapped with `with-env --app frontend --` so drizzle-kit gets `DATABASE_URL` from the same files.
- `env:tailscale`: `tsx infra/local/scripts/gen-tailscale-env.ts` — the on-demand generator.
- `tsx` already used by scripts; if not a dep, add it exact-pinned.

## What this unlocks (the tailnet-access motivation)

Method A (phone access via `tailscale serve`) becomes clean: `SERVICE_DOMAIN=www.mocco.work` stays the committed default; a developer runs `yarn env:tailscale` once to point `SERVICE_DOMAIN` at their tailnet node in `env/.env`, then `tailscale serve` exposes it on 443. `resolveAuthOrigins` derives baseUrl/trustedOrigins from whichever `SERVICE_DOMAIN` wins — no code change, no committed personal host, and auth/callback code stays Tailscale-blind.

## Testing / verification

- **`with-env.ts` pure parts:** `parseDotenv` (quotes/comments/`=`-in-value) and the 2-way merge precedence (`.env` beats `.env.local`).
- **`gen-tailscale-env.ts` pure parts:** `dnsNameFromStatus` (extracts + strips trailing dot; errors when absent) and `upsertEnvLine` (replaces in place / appends / preserves other lines).
- **`SERVICE_DOMAIN` product change:** update `origins.ts` tests to the renamed `serviceDomain` param + `https://` composition (RED→GREEN); the preview/local/trusted-origins cases must still pass.
- **Manual/CI:** `yarn dev` boots with env applied (banner shows counts); `yarn db:generate` picks up `DATABASE_URL`; `yarn verify` stays green.
- No `vi.mock`; the `tailscale`/`fs`/network I/O is the untested shell around tested pure functions.

## Scope / boundaries

- **In:** the `SERVICE_DOMAIN` rename (`env.ts` + `origins.ts`, `AUTH_URL` removed, `https://` composed in code), the `with-env.ts` two-layer loader, the `gen-tailscale-env.ts` generator, the `packages/frontend/env/` layout, script wiring, `.gitignore`, a short docs page (`docs/reference/env.md` + AGENTS.md pointer).
- **Out:** `tailscale serve`/mkcert/traefik setup (documented, not automated here); any remote secrets endpoint (dropped from the design — Tailscale is now local-only via the generator); other product behavior.
- **Coordination:** the `AUTH_URL`→`SERVICE_DOMAIN` rename lands on `main`; the run-execution branch (which derives `callbackBaseUrl` via `resolveAuthOrigins`) picks it up on rebase — no separate change needed there.
- **Not** stacked on 3c/run-execution — independent chore off `main`.

## Open question (confirm before implementing)

`SERVICE_DOMAIN` is a bare host and the scheme is always `https`. This drops the ability to express `http://localhost:3100` as the service origin. That's fine given ADR 0006 (local dev already runs over `https://www.mocco.work` via traefik+mkcert, not raw localhost) — but if a raw-localhost/http dev mode is ever wanted, it would need a port/scheme escape hatch. Flagged, not built (YAGNI).
