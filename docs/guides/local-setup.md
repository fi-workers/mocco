---
title: Local development setup (mocco.work)
type: guide
status: active
created: 2026-07-01
updated: 2026-07-04
confidence: high
owner: andrea
tags: [guide, local, setup, traefik]
related:
  - ../adr/0006-domains-mocco-club-prod-mocco-work-local.md
---

# Local development setup

> Ported from the showyourtime harness pattern. prod = `www.mocco.club` · local browsing = `https://mocco.work` (traefik+mkcert). ADR 0006.

## Layout

```
Browser  → https://mocco.work  → traefik(:443, mkcert TLS) → Next(localhost:3100)
Local DB → docker compose postgres(:5432)
```

## One-time setup

```bash
make application   # brew: mkcert nss traefik node corepack
make initialize    # certs(mkcert) + hosts(/etc/hosts, sudo) + yarn install
make docker-up     # local Postgres
yarn db:generate && yarn db:migrate
```

- `make certs` — `mkcert mocco.work '*.mocco.work'` → `infra/local/cert/` (gitignore)
- `make hosts` — add `mocco.work`, `www.mocco.work`, `host.docker.internal` → 127.0.0.1 to `/etc/hosts`

## Development

```bash
make dev      # = yarn dev = concurrently(run-frontend + run-traefik)
              # → visit https://mocco.work (traefik→Next:3100)
```

## Environment variables

Copy `src/frontend/.env.example` → `.env`:
- `APP_URL`/`BETTER_AUTH_URL` = `https://mocco.work` (browser-redirect OAuth is fine locally)
- `DATABASE_URL` = local pg

## Login (Better Auth + GitHub OAuth)

The **OAuth App** for login is separate from the **GitHub App** for repo webhooks.

1. GitHub → Settings → Developer settings → **OAuth Apps** → New
   - Homepage URL: `https://mocco.work`
   - Authorization callback URL: `https://mocco.work/api/auth/callback/github`
   - (prod uses a separate app: `https://www.mocco.club/api/auth/callback/github`)
2. Fill in `.env`:
   - `BETTER_AUTH_SECRET` = `openssl rand -base64 32`
   - `BETTER_AUTH_URL` = `https://mocco.work`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
3. `make dev` → `https://mocco.work` → "Continue with GitHub" → after the callback, `/account`.

- Route: `app/api/auth/[...all]` = `toNextJsHandler(auth)` (the auth instance lives in `@mocco/backend`)
- Tables: `mocco_users`/`mocco_sessions`/`mocco_accounts`/`mocco_verifications` (uuid PK, DB-generated via `generateId:false`)
- Smoke test: `curl .../api/auth/get-session` → `null` (200) means the wiring is correct.

## Webhooks & OIDC callbacks (later — GitHub App integration)

GitHub webhooks and Actions callbacks need a publicly reachable URL, which local browsing does not.
A cloudflared tunnel (`dev.mocco.work` → localhost:3100) will be reintroduced together with the
GitHub App integration; it is intentionally not part of the base local setup.
