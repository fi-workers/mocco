---
title: Env management — with-env wrapper (design)
description: Replace Next's built-in .env loading with an explicit with-env wrapper giving a three-step precedence — committed .env.local defaults → Tailscale team secrets (memory-only) → gitignored .env personal override — so committed shared config, team secrets, and personal overrides are cleanly separated. Ported from algocare-home's proven with-env.ts.
type: design
status: active
created: 2026-07-25
owner: andrea
related:
  - ../../adr/0005-tech-stack-vercel-native-next-fullstack.md
  - ../../adr/0006-domains-mocco-club-prod-mocco-work-local.md
---

# Env management — `with-env` wrapper

> A dev-infra chore (not a product slice). Today mocco leans on Next's built-in `.env` loading, whose precedence (`.env.local` > `.env`) mixes committed shared config with personal/secret values. Adopt algocare-home's proven **`with-env.ts`** convention so the three roles are explicit and separate. Off `main`, its own chore PR.

## Goal

One clear env story:
- **`env/.env.local` — committed, non-secret shared defaults.** A fresh clone runs with just this. (e.g. `AUTH_URL=https://www.mocco.work`, local `DATABASE_URL`, the Tailscale secrets URL.)
- **Tailscale — team-shared secrets, fetched at runtime into memory only** (never written to disk). Configurable tailnet URL; **graceful skip** when unset/unreachable.
- **`env/.env` — personal override, gitignored, wins.** Secrets + per-developer values (e.g. `AUTH_URL` = the tailnet `*.ts.net` URL for phone access, `AUTH_SECRET`, `GITHUB_APP_*`, `EXECUTOR_SECRET`).

Precedence (later overrides earlier): **`.env.local` → Tailscale → `.env`**. This is the inverse of Next's built-in order, which is exactly why we stop relying on Next's loader.

## Why a wrapper (not Next's built-in)

Next auto-loads `packages/frontend/.env*` and forces `.env.local` > `.env` — the opposite of what we want, and it can't be reconfigured. The fix (proven in algocare-home): a small `with-env` script loads the files in OUR order + merges Tailscale secrets, then execs the child (`next dev`, `drizzle-kit`) with the merged env. **Key trick: env files live in a `env/` subdirectory** (`packages/frontend/env/`), which Next's root-only auto-loader never sees — so our precedence stands and there's no double-load.

## Design

- **`infra/local/scripts/with-env.ts`** — ported/adapted from algocare-home (`infra/local/scripts/with-env.ts`). Responsibilities, in order:
  1. Parse `--app <name> [--env <environment>] -- <command…>` (default env `local`).
  2. Load `packages/<app>/env/.env.<environment>` (the committed defaults; `.env.local` for env `local`) — a tiny dependency-free dotenv parser (quotes stripped, `#` comments skipped), mirroring the reference.
  3. **Tailscale fetch** from a configurable URL (`MOCCO_TAILSCALE_ENV_URL`, read from the already-loaded step-2 vars or `process.env`): `GET` the URL, parse as dotenv, **memory only**. `AbortController` timeout (~3s); on unset/non-200/network-fail → warn + skip (never fail the command).
  4. Load `packages/<app>/env/.env` (gitignored personal override).
  5. Merge `{ ...step2, ...step3, ...step4 }` (later wins) and `spawn` the command with `{ ...process.env, ...merged }`. Print a short banner (app, env, counts, resolved app URL).
- **Env file layout** (new `packages/frontend/env/`):
  - `env/.env.local` — committed defaults (move the current root `.env.example`'s non-secret defaults here; set `AUTH_URL=https://www.mocco.work`, local `DATABASE_URL`, `MOCCO_TAILSCALE_ENV_URL=` placeholder-empty for now).
  - `env/.env.example` — the template documenting what a developer puts in `env/.env` (secrets + personal overrides, incl. the tailnet `AUTH_URL`).
  - `env/.env` — **gitignored**, developer-created.
  - Remove the old root `packages/frontend/.env.example` (superseded).
- **Script wiring** (root `package.json`):
  - `run-frontend`: `yarn frontend dev` → `tsx infra/local/scripts/with-env.ts --app frontend -- yarn frontend dev` (the frontend `dev` stays `next dev -p 3100`). `dev` (concurrently run-frontend + run-traefik) unchanged in shape.
  - `db:generate` / `db:migrate`: wrap with `with-env --app frontend --` so drizzle-kit gets `DATABASE_URL`/`DIRECT_URL` from the same files (today they read `process.env` with a localhost fallback).
  - `tsx` is already available (used by scripts); if not a dep, add it exact-pinned.
- **`.gitignore`** — currently ignores `.env` + `.env.*` (except `.env.example`). Adjust so `packages/frontend/env/.env.local` and `env/.env.example` are **committed**, while `packages/frontend/env/.env` (and any stray root `.env*`) stay ignored. Explicit allowlist entries for the two committed files.
- **Tailscale endpoint** — the fetch step is fully implemented but its source URL (`MOCCO_TAILSCALE_ENV_URL`) starts **unset** → the step skips gracefully. Standing up an actual tailnet secrets endpoint (e.g. `tailscale serve` on a fi-workers/Mac-mini host serving `…/mocco/frontend/.env`) is a **separate ops task**, out of scope here. The code is ready the moment the URL is set.

## What this unlocks (the tailnet-access motivation)

Method A (phone access via `tailscale serve`) becomes clean: keep `AUTH_URL=https://www.mocco.work` as the committed default in `env/.env.local`, and each developer overrides `AUTH_URL=https://<their-mac>.<tailnet>.ts.net` in their gitignored `env/.env`. `resolveAuthOrigins` (unchanged) then derives baseUrl/trustedOrigins from whichever wins — no code change to auth, no committed personal URL.

## Testing / verification

- **`with-env.ts` pure parts are unit-tested**: `parseDotenv` (quotes/comments/`=`-in-value) and the 3-way merge precedence (`.env` beats Tailscale beats `.env.local`). The Tailscale fetch is behind an injected/blockable seam so the merge test needs no network (unset URL → skip path).
- **Manual/CI**: `yarn dev` boots with env applied (banner shows counts); `yarn db:generate` picks up `DATABASE_URL`; `yarn verify` stays green (the wrapper doesn't touch verify's steps, but confirm nothing regressed).
- No product-behavior tests (dev-infra only). No `vi.mock`.

## Scope / boundaries

- **In:** the `with-env.ts` wrapper (3-step precedence incl. a working, skippable Tailscale fetch), the `packages/frontend/env/` file layout, script wiring, `.gitignore`, a short docs note (AGENTS.md pointer + a `docs/reference/` env page).
- **Out:** standing up the actual tailnet secrets endpoint (separate ops); mkcert/traefik/`www.mocco.work` changes (orthogonal); any product code. `AUTH_URL`/`resolveAuthOrigins` logic is unchanged — this is purely how env values are *loaded*.
- **Not** stacked on 3c/run-execution — independent chore off `main`.
