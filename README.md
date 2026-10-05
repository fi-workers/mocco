# Mocco

[![CI](https://github.com/fi-workers/mocco/actions/workflows/ci.yml/badge.svg)](https://github.com/fi-workers/mocco/actions/workflows/ci.yml)

> **Everything your product needs, except the code.** Ship it, run it and hear from the people who use it, in one workspace. Deploys, OTA updates, feature flags, alerts, a status page, in-app messaging and your help center share the same team, the same roles and the same history, instead of separate tools that don't know about each other ([ADR 0029](./docs/adr/0029-mocco-is-everything-a-product-needs-except-the-code.md)).

| Group          | Products today                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Release**    | Deploy governance on GitHub Actions · OTA updates (hosted, or gating your own tool) · Force update · Feature flags (OpenFeature) |
| **Operate**    | Status page (components, incidents, maintenance) · Notifications (Mocco, Sentry, Vercel, GitHub → Discord) · Audit log           |
| **Support**    | Messenger · Help center                                                                                                          |
| **Developers** | Public `/v1` API with API keys · SDKs (MIT) · `mocco` CLI · MCP server                                                           |

Next on the [roadmap](./docs/reference/roadmap.md): status page, app reviews, feedback board, forum, deep links and end-user identity.

**Release: write ≠ ship.** Being able to push code (or to generate it) doesn't mean being able to change production. A deploy waits at a gate until someone with the right Mocco role resumes it, and the production step never obtains cloud credentials (OIDC/STS) without that approval, so deleting the verify step bypasses nothing. The same holds for an OTA release on a protected channel, a raised minimum app version and a change to a protected flag environment. A rollback or a kill switch applies at once and is recorded.

## Quickstart (local)

```bash
make application     # brew: mkcert nss traefik node corepack
make initialize      # certs + /etc/hosts + yarn install
make docker-up       # local Postgres
yarn db:migrate      # apply schema
yarn db:seed         # sample data (optional)
make dev             # https://www.mocco.work (traefik → Next :3100)
```

Details: [docs/guides/local-setup.md](./docs/guides/local-setup.md)

## Self-hosting

Mocco is self-hostable. Requirements: Node 22+ and Postgres — login is email+password, so no OAuth app is needed. (A GitHub App for webhooks & dispatch arrives with the repo-integration phase.) It deploys as a regular Next.js app — Vercel is not required. (A dedicated self-hosting guide is in progress; see the local setup guide in the meantime.)

## Structure

```
packages/frontend/src/   @mocco/frontend  Next.js UI (app/api mounts the backend)
packages/backend/src/    @mocco/backend   domain · db (Drizzle) · tRPC · handlers
packages/common/src/     @mocco/common    shared zod schemas & types
docs/           llm-wiki (ADRs · concepts · guides) — start at docs/index.md
docs/prototype/ non-functional click-through (design validation)
```

## Development harness

- lint: **ESLint 10 flat** (airbnb-extended + typescript-eslint strict + unicorn + sonarjs), prettier
- test: Vitest (backend, including pglite integration tests) · build: Next.js
- `make dev` / `yarn lint` / `yarn test` / `yarn format` / `yarn frontend build`
- CI gates every PR with the same checks: format:check · docs lint · lint+ts · tests · migration drift · build (`.github/workflows/ci.yml`)
- Decision records: `docs/adr/`

## License

[AGPL-3.0](./LICENSE). Free to self-host, modify, and redistribute. If you offer Mocco as a network service, AGPL terms apply (source of your modifications must be made available). For commercial use where AGPL doesn't fit, contact us about a separate license.
