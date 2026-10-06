---
title: Env management (SERVICE_DOMAIN, with-env, tailnet access)
description: How env files are laid out and loaded — the committed/personal file split, why a wrapper replaces Next's built-in loader, the SERVICE_DOMAIN canonical host, and the Tailscale tailnet-access recipe.
type: reference
status: active
created: 2026-07-25
updated: 2026-10-06
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

### Cold starts

The region fixed the warm path, but the first request after the API function had gone idle was still slow (#419). Traced on 2026-10-06 against production:

- **The project**: Fluid compute is on (`resourceConfig.fluid: true`), with Node 24 and standard 2 GB functions. Vercel's bytecode caching therefore applies (Node 20+, production only), but it caches CommonJS only.
- **The functions**: the deployment has three. The Pages Router API routes (`/api/auth`, `/api/trpc`, `/api/seo`, `/api/help`) share one, together with `/api/mcp` and the `.well-known` OAuth metadata. `/api/ext` is the second and the pages are the third. The per-minute job tick keeps `/api/ext` warm but not the API function.
- **Instance reuse**: an idle instance of the API function survived anywhere from about 5 to more than 8 minutes. In five rounds spaced 8 minutes apart, three landed on a fresh instance. A deploy always starts fresh. So the console's first call after a coffee break usually pays a cold start.
- **The cold request**: an unauthenticated `GET /api/auth/get-session` took 2.3–3.0 s cold (five samples) and 0.05–0.36 s warm. Vercel's request log and the Supabase pooler's log show the pooler accepting the request's database login 2.26–2.90 s after the request reached Vercel, about 0.1 s before the response finished. Connecting to the pooler is cheap: TCP, the Postgres SSL request and TLS take 27–37 ms even from a Seoul home connection, and less from `icn1`. So nearly all of the cold time passes before the database is touched. That time is function init: booting the instance and loading the route's code.
- **Init without the database**: preview deployments have no `AUTH_SECRET`, so better-auth fails before it opens a connection, and the pooler logged no login. A cold `get-session` there still took 2.85–3.32 s. That is init alone, a little slower than production because previews get no bytecode caching.
- **What init was loading**: Next doesn't bundle the Pages Router's dependencies by default (`bundlePagesRouterDependencies: false`), so each route `require`d or `import`ed its packages from `node_modules` at runtime. The trace lists 1,222 files for the auth route and 2,320 for tRPC, which also pulls in Sentry and OpenTelemetry (about 600 modules). Resolving `package.json`s and compiling those files dominates a local CPU profile. better-auth, drizzle and zod load as ESM, which bytecode caching skips.
- **The database's share**: each new instance opens one pooler connection, and better-auth's first request seeds the MCP OAuth resource row, which takes one `SELECT`. Together that is tens of milliseconds in-region. It isn't the bottleneck, so it stays as it is.

The fix is `bundlePagesRouterDependencies: true` in `next.config.ts`, so the Pages Router bundles its dependencies the way the App Router already does. Traced files drop from 1,222 to 223 (auth) and from 2,320 to 412 (tRPC), and the API function's deployed size drops from 11.7 MB to 9.9 MB. Measured cold on preview deployments in `icn1`, the same build without and with the change, after 10 minutes idle (these requests end in the missing-secret error, so they time init and nothing else):

| Cold, preview, init only                             | Before (5 samples) | After (4 samples) |
| ---------------------------------------------------- | ------------------ | ----------------- |
| `get-session`, first request on a fresh instance     | 2.85–3.32 s        | 0.99–1.42 s       |
| tRPC, the instance's first tRPC call right after it  | 1.07–1.21 s        | 0.57–0.77 s       |

Locally (Apple silicon, a fresh `next` production server per sample, entries loaded on first request as on Vercel, a local Postgres), the cold first request dropped as follows. Warm requests are unchanged.

| Cold first request, local                   | Before | After  |
| ------------------------------------------- | ------ | ------ |
| `get-session`, signed out                   | 400 ms | 130 ms |
| `get-session`, signed in                    | 450 ms | 150 ms |
| tRPC batch (`workspace.list` ×2), signed in | 625 ms | 283 ms |
| `/api/seo/robots`                           | 256 ms | 100 ms |

Production's numbers after the change come with the next deploy. The remaining second or so is booting the instance and compiling the bundled chunks, which bytecode caching shortens in production.

The trade-off: the build's server chunks grow (the `.next/server/chunks` directory went from 59 MB to 82 MB, since the dependencies now live in the chunks instead of `node_modules`), and a package that can't be bundled has to be listed in `serverExternalPackages`. That covers a native addon, or a package that reads files from beside its own source. resvg and satori are already listed for the OG renderer, and Next's built-in list keeps `pg` external.

What was weighed and not done:

- **A warm-up ping**, a cron hitting the API function, would hide the cold start only for the instance it keeps, and costs an invocation a minute.
- **Splitting `/api/auth` out of the shared function** doesn't help, because the console needs both auth and tRPC on its first screen.
- **Opening the database connection at import time** would move a cheap step earlier without removing the expensive one.

To watch cold starts per route over time you need Observability Plus. Without it the observability query API returns 402, so this trace used request logs, the pooler's logs and timed `curl` requests instead.

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

## Email vars

`EMAIL_DRIVER` picks the email sender (`domain/notification/email-config.ts`): `smtp` sends through `EMAIL_SMTP_URL`
(`smtp://user:pass@host:587`, STARTTLS when the relay offers it, or `smtps://…:465`) from `EMAIL_FROM`
(`Acme Status <status@acme.example>`); both are required with it. `log` is the development sink: each mail, links
included, is written to the server log and nothing is sent, so never use it in production. Unset, nothing is sent and
status page sign-ups answer `503`. For a real SMTP round trip in development, point `smtp` at a local catcher such as
Mailpit (`smtp://localhost:1025`). Status subscriber links are signed with a key derived from `AUTH_SECRET`.

## Messenger vars

`EXPO_ACCESS_TOKEN` (optional) is sent to Expo's push service with messenger reply notifications, for Expo projects that require an access token ("enhanced push security"). Without it, pushes go out unauthenticated, which Expo accepts unless the project requires one. Attachments use [object storage](./storage.md). See [Messenger](./messenger.md#push).

## Ops (stage0) vars

Stage0 is Mocco's own watchdog ([notification relay design §11](../superpowers/specs/2026-09-25-notification-relay-design.md#11-dogfooding-moving-the-team-relay-onto-mocco),
[stage0 canary](./notifications.md#stage0-canary)). Every five minutes the `stage0.canary` job sends a signed
synthetic GitHub push through Mocco's public ingest route; a rule routes it to a private Discord channel; once the
message is posted (and deleted again), Mocco pings `OPS_HEARTBEAT_URL`. If the ingest route, the DB, the job queue or
the Discord sender breaks, the pings stop and the dead-man switch behind the URL alerts the team, outside Mocco.

- `OPS_HEARTBEAT_URL`: the ping URL of an external dead-man switch, pinged with a `GET`. It carries a token, so keep
  it secret; Mocco never logs it. For example a [heartbeat monitor](./status.md#heartbeat-monitors) on a separate
  Mocco install (`https://<other-install>/api/ext/v1/ping/mhb_…`) or a healthchecks.io check
  (`https://hc-ping.com/<uuid>`). Never point it at the same install it watches.
- `OPS_CANARY_SOURCE_ID`: the id (uuid) of the GitHub inbound source the canary goes to.

Both unset, stage0 is off and nothing is scheduled. Only one set, it stays off and the job runner logs a warning. The
canary also needs `SECRETS_ENCRYPTION_KEYS` (to sign with the source's secret), `DISCORD_BOT_TOKEN` and the job tick.

Turning it on (operations, no deploy of code):

1. In an operator workspace (not a customer's), create an inbound source of kind **GitHub** named `stage0 canary`. Use
   it for nothing else: every delivery from it is treated as a canary, deleted from Discord and pinged for. Copy its id.
2. Add a private Discord channel (only the bot and operators can see it) to that workspace as a notification channel.
3. Add a rule on that channel: event `github.push`, limited to the canary source.
4. Create the dead-man switch with a **5-minute period and a 10-minute grace**, so it alerts at most 15 minutes after
   the last canary got through, and point its alerts somewhere that doesn't depend on Mocco (its own Discord, email
   or phone integration). On another Mocco install that is a heartbeat monitor with period 5 and grace 10 minutes.
5. Set `OPS_HEARTBEAT_URL` and `OPS_CANARY_SOURCE_ID` in the production env and redeploy, so the next tick picks them
   up.
6. Check it within ten minutes: the source shows a receipt every five minutes, the channel's deliveries are `sent`, the
   channel itself stays empty, and the dead-man switch shows pings. Then watch it for a few days before moving Mocco's
   own alerts onto Mocco.

To turn it off, unset both variables. Pausing the canary source also stops the pings (and so alerts), which is how to
test the alert path end to end.

## Scripts

- `yarn dev` (→ `run-frontend`), `yarn db:generate`, `yarn db:migrate` all run through `with-env`, so `next dev`/`drizzle-kit` see the merged `env/.env.local` → `env/.env`.
- `yarn env:tailscale` regenerates the tailnet `SERVICE_DOMAIN` in `env/.env` (see above).
- `yarn build`/`yarn test`/`yarn lint`/`yarn db:drift`/`yarn schema:*`/e2e are unchanged — CI and e2e supply env directly, and drizzle keeps its own localhost `DATABASE_URL` fallback.
