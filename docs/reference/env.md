---
title: Env management (SERVICE_DOMAIN, with-env, tailnet access)
description: How env files are laid out and loaded — the committed/personal file split, why a wrapper replaces Next's built-in loader, the SERVICE_DOMAIN canonical host, and the Tailscale tailnet-access recipe.
type: reference
status: active
created: 2026-07-25
owner: andrea
tags: [reference, env, config, auth, tailscale]
---

# Env management

AGENTS.md carries the terse rule ("env access is centralized"); this page covers the file layout, the loader that replaces Next's built-in one, `SERVICE_DOMAIN`, and the tailnet-access recipe it unlocks.

## Two files, two roles

Env files for `packages/frontend` live under `packages/frontend/env/`, not the package root:

| File | Committed? | Contains |
| --- | --- | --- |
| `env/.env.local` | Yes | Non-secret shared defaults — `SERVICE_DOMAIN=www.mocco.work`, the local `DATABASE_URL`. A fresh clone boots on this file alone. |
| `env/.env` | No (gitignored) | Personal + secret overrides — `AUTH_SECRET`, `GITHUB_APP_*`, a tailnet `SERVICE_DOMAIN`. **Wins** over `.env.local`. |

`env/.env.example` is committed too — it's a template documenting what to put in the gitignored `env/.env`, not a real env file itself.

## Precedence, and why the wrapper

Loading order is **later wins: `.env.local` → `.env`**. This is the inverse of Next's own built-in precedence, where `.env.local` overrides `.env` — a shape meant for "committed `.env` defaults, gitignored `.env.local` machine overrides" but easy to get backwards, and one that mixes shared config and personal secrets in ways that don't map cleanly onto "safe to commit" vs "never commit."

Because we need the opposite order (personal file wins over committed defaults) and want the two roles to stay unambiguous, we stop relying on Next's loader entirely and go through an explicit two-layer wrapper: `infra/local/scripts/with-env.ts`. It:

1. Parses `--app <name> [--env <environment>] -- <command…>` (default env `local`).
2. Loads `packages/<app>/env/.env.<environment>` (committed defaults) via a small dependency-free dotenv parser.
3. Loads `packages/<app>/env/.env` (personal override), same parser.
4. Merges `{ ...defaults, ...personal }` and spawns the command with the merged env (`stdio: 'inherit'`, exit code propagated), printing a short banner (app, env, var counts loaded).

The loader is deliberately dumb — two files, later wins, no remote fetch, no provider awareness. `parseDotenv` and `mergeEnv` are pure and unit-tested; the file reads and `spawn` are the untested shell around them.

## The `env/` subdirectory trick

The files live in `packages/frontend/env/`, not `packages/frontend/` itself. Next.js auto-loads `.env*` files from a package root — if our files sat there too, Next would load them a second time under its own (wrong-for-us) precedence, on top of what `with-env` already merged. Nesting them one level down keeps them invisible to Next's auto-loader, so our precedence is the only one that applies.

## `SERVICE_DOMAIN` — the canonical app host

One env var answers "what host is this app served at?" — a **bare authority** (`host` or `host:port`, no scheme, no path): `www.mocco.work`, `www.mocco.club`, `localhost:3100`, `mac-mini.tailfd5d.ts.net`. It replaced the old `AUTH_URL`, which carried a full URL.

The scheme is derived, not stored. `resolveAuthOrigins` (`packages/backend/src/domain/auth/origins.ts`) composes it via a private `schemeFor(host)`: a loopback host (`localhost`, `127.*`, `[::1]`) → `http`; everything else → `https`, since every real deploy terminates TLS on 443 (traefik+mkcert locally, `tailscale serve` on the tailnet, the platform in prod/preview). This keeps `SERVICE_DOMAIN` a plain host while still expressing the e2e server's `http://localhost:3100`.

Values per environment:

- **local**: `SERVICE_DOMAIN=www.mocco.work` (committed default in `env/.env.local`)
- **prod**: `SERVICE_DOMAIN=www.mocco.club`
- **e2e**: `SERVICE_DOMAIN=localhost:3100` (set in `packages/e2e/playwright.config.ts`)
- **preview**: derived from `VERCEL_URL` — a separate branch in `resolveAuthOrigins`, `SERVICE_DOMAIN` isn't consulted there
- **tailnet**: `SERVICE_DOMAIN=<node>.<tailnet>.ts.net` — written into the gitignored `env/.env` by the generator below

## Tailnet access (method A: phone on the tailnet)

Tailscale is a developer-machine concern, confined to **one generator script** — `infra/local/scripts/gen-tailscale-env.ts`. Nothing else (the loader, `env.ts`, `resolveAuthOrigins`) knows Tailscale exists; they only ever see `SERVICE_DOMAIN`, an ordinary env var. Swapping in a real domain, ngrok, or plain localhost later is just a different `SERVICE_DOMAIN` value — no code changes anywhere.

The recipe:

1. `yarn env:tailscale` — runs the generator, which reads `tailscale status --json` → `Self.DNSName`, strips the trailing dot, and upserts `SERVICE_DOMAIN=<your-node>.<tailnet>.ts.net` into `packages/frontend/env/.env` (personal file — wins over the committed local default). Account-agnostic: it reads whatever tailnet node is currently active, so it adapts to any logged-in machine.
2. Expose the dev server on 443 over the tailnet: `tailscale serve`. This step is manual and not automated by the generator — the exact invocation depends on your installed Tailscale version, but the intent is to forward `https://<node>.<tailnet>.ts.net` to the local Next dev server (`localhost:3100`), e.g. something like `tailscale serve --bg https+insecure://localhost:3100`. Check `tailscale serve --help` / current docs for the exact flags on your version.
3. `yarn dev` (through `with-env`, which now picks up the tailnet `SERVICE_DOMAIN` from `env/.env`) and open `https://<node>.<tailnet>.ts.net` from a phone joined to the same tailnet.

If `tailscale` isn't installed or isn't up, the generator fails loudly with a clear error and non-zero exit — it's an explicit opt-in dev command, so silent fallback would be worse than failing.

## Scripts

- `yarn dev` (→ `run-frontend`), `yarn db:generate`, `yarn db:migrate` all run through `with-env`, so `next dev`/`drizzle-kit` see the merged `env/.env.local` → `env/.env`.
- `yarn env:tailscale` regenerates the tailnet `SERVICE_DOMAIN` in `env/.env` (see above).
- `yarn build`/`yarn test`/`yarn lint`/`yarn db:drift`/`yarn schema:*`/e2e are unchanged — CI and e2e supply env directly, and drizzle keeps its own localhost `DATABASE_URL` fallback.
