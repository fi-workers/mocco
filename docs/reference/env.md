---
title: Env management (SERVICE_DOMAIN, with-env, tailnet access)
description: How env files are laid out and loaded — the committed/personal file split, why a wrapper replaces Next's built-in loader, the SERVICE_DOMAIN canonical host, and the Tailscale tailnet-access recipe.
type: reference
status: active
created: 2026-07-25
updated: 2026-10-05
confidence: medium
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

## `SECRETS_ENCRYPTION_KEYS` — SecretBox keys

Keys for sealing third-party secrets at rest (see backend-conventions → Secrets at rest):
`keyId:base64key[,older…]`. The first key seals, every listed key opens. Optional until a feature
stores secrets; that feature then fails with an error naming the variable. Generate one with
`echo "k1:$(openssl rand -base64 32)"` and put it in the gitignored `env/.env` (and in the Vercel
project env for deploys).

## Tailnet access (method A: phone on the tailnet)

Tailscale is a developer-machine concern, confined to **one generator script** — `infra/local/scripts/gen-tailscale-env.ts`. Nothing else (the loader, `env.ts`, `resolveAuthOrigins`) knows Tailscale exists; they only ever see `SERVICE_DOMAIN`, an ordinary env var. Swapping in a real domain, ngrok, or plain localhost later is just a different `SERVICE_DOMAIN` value — no code changes anywhere.

The recipe:

1. `yarn env:tailscale` — runs the generator, which reads `tailscale status --json` → `Self.DNSName`, strips the trailing dot, and upserts `SERVICE_DOMAIN=<your-node>.<tailnet>.ts.net` into `packages/frontend/env/.env` (personal file — wins over the committed local default). Account-agnostic: it reads whatever tailnet node is currently active, so it adapts to any logged-in machine.
2. Expose the dev server on 443 over the tailnet: `tailscale serve`. This step is manual and not automated by the generator — the exact invocation depends on your installed Tailscale version, but the intent is to forward `https://<node>.<tailnet>.ts.net` to the local Next dev server (`localhost:3100`), e.g. something like `tailscale serve --bg https+insecure://localhost:3100`. Check `tailscale serve --help` / current docs for the exact flags on your version.
3. `yarn dev` (through `with-env`, which now picks up the tailnet `SERVICE_DOMAIN` from `env/.env`) and open `https://<node>.<tailnet>.ts.net` from a phone joined to the same tailnet.

If `tailscale` isn't installed or isn't up, the generator fails loudly with a clear error and non-zero exit — it's an explicit opt-in dev command, so silent fallback would be worse than failing.

## Job tick vars

`CRON_SECRET` (the name Vercel Cron sends as a bearer), `JOBS_TICK_SECRET` (our self-host alias) and `JOBS_TICK_BUDGET_MS` (default 50000) configure the background-job tick. All are optional; with neither secret set the tick route answers 503. The same secret lets the backend ask `/api/help/revalidate` to rebuild help center pages right after a change; without it they refresh within a minute. See [Background jobs and schedules](./jobs.md#env).

## Public API host

`PUBLIC_API_DOMAIN` (a bare host such as `api.mocco.club`, read by `next.config.ts` at build time) serves the public API at `https://<that host>/v1/*`, rewritten to the ext app's `/api/ext/v1/*`. Unset, the API is only at `/api/ext/v1`. See [public API](./public-api.md).

`HELP_SITES_DOMAIN` (a bare domain such as `help.mocco.club`, read by `next.config.ts` at build time) serves each help center at `https://<site slug>.<that domain>/`, rewritten to `pages/_sites/<site>/*` ([ADR 0015](../adr/0015-public-sites-use-isr-on-the-pages-router.md)). The domain needs a wildcard DNS record and certificate pointing at the deployment. Locally, `help.localhost:3217` works without DNS (the port is ignored by the rewrite and kept in the console's link to the site). Unset, help centers aren't served. The backend reads it (and `HELP_CUSTOM_DOMAINS`) too, to put absolute article URLs in `/v1/help/search` answers.

`HELP_CUSTOM_DOMAINS` (comma-separated `domain=site-slug` pairs, such as `help.showyourti.me=showyourtime`, read by `next.config.ts` at build time) serves a help center on the customer's own domain. Each domain must also be added to the Vercel project and point at it (a CNAME to Vercel's DNS). The console links the site there instead of `<slug>.<HELP_SITES_DOMAIN>`.

`AI_GATEWAY_API_KEY` (a Vercel AI Gateway key) turns on help center translation: publishing an article queues a translation into each language the site offers. `HELP_TRANSLATION_MODEL` picks the model (an AI Gateway model id, default `anthropic/claude-sonnet-5`). Unset, nothing is translated and readers get the source language.

## Function region

On Vercel, `packages/frontend/vercel.json` pins the functions to `icn1` (Seoul), next to the production database (Supabase `ap-northeast-2`). A console tRPC call makes several sequential queries, so the function belongs where the database is: from the default `iad1` each round trip crossed the Pacific, and the batched tRPC call behind a console page took about 10 s (0.3 s from `icn1`). Public `/v1` handlers read the same database, so they benefit the same way; CORS preflights answer without it. A deployment with its database elsewhere sets `regions` to that database's region. Self-hosting ignores the file.

## Storage vars

`STORAGE_DRIVER` (`s3` or `filesystem`) picks the object store; see [object storage](./storage.md). Unset, local dev uses `filesystem` and Vercel has none.

- `s3`: `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` (required), `STORAGE_ENDPOINT` (R2: `https://<account>.r2.cloudflarestorage.com`; omit for AWS), `STORAGE_REGION` (default `auto`), `STORAGE_PUBLIC_BASE_URL` (the CDN serving `pub/`).
- `filesystem`: `STORAGE_FS_ROOT` (default `.mocco-storage` in the working directory), `STORAGE_SIGNING_SECRET` (default: derived from `AUTH_SECRET`).

## Discord vars

`DISCORD_BOT_TOKEN` (the Mocco bot's token, used by every Discord call) and `DISCORD_CLIENT_ID` /
`DISCORD_CLIENT_SECRET` (the bot install OAuth pair) configure notifications. All are optional;
without the token, deliveries wait instead of sending. See [Notifications](./notifications.md#env).

## Status probe vars

`STATUS_PROBE_EMBEDDED=true` makes a single-node self-hosted server run the status page's probe loop in-process as
the shared `embedded` location, starting with the first job tick after boot (so it needs `JOBS_TICK_SECRET` and the
per-minute tick). `STATUS_PROBE_CONCURRENCY` (1 to 200, default 20) is how many of its checks run at once. Both are
ignored on Vercel. See [the embedded probe](./status.md#the-embedded-probe). A probe that runs elsewhere is
configured by its own `MOCCO_*` variables, not by the server's env.

`STATUS_RAW_RETENTION_DAYS` (1 to 365, default 14) is how many days of raw status check results are kept, today
included; the `status.retention` job drops older days' partitions. Uptime history doesn't depend on it: rollups come
from the round verdicts and the state changes. See [time series](./status.md#time-series-and-their-partitions).

## Messenger vars

`EXPO_ACCESS_TOKEN` (optional) is sent to Expo's push service with messenger reply notifications, for Expo projects that require an access token ("enhanced push security"). Without it, pushes go out unauthenticated, which Expo accepts unless the project requires one. Attachments use [object storage](./storage.md). See [Messenger](./messenger.md#push).

## Scripts

- `yarn dev` (→ `run-frontend`), `yarn db:generate`, `yarn db:migrate` all run through `with-env`, so `next dev`/`drizzle-kit` see the merged `env/.env.local` → `env/.env`.
- `yarn env:tailscale` regenerates the tailnet `SERVICE_DOMAIN` in `env/.env` (see above).
- `yarn build`/`yarn test`/`yarn lint`/`yarn db:drift`/`yarn schema:*`/e2e are unchanged — CI and e2e supply env directly, and drizzle keeps its own localhost `DATABASE_URL` fallback.
