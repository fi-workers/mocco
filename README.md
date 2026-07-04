# Mocco

> A **deploy governance control plane** on top of GitHub Actions. GitHub Actions runs your pipelines; Mocco owns the **pause/resume gates** — approvals, separation of duties, audit, and credential gating.
> Long-term vision: a unified ops control plane covering health checks and monitoring.

**Core idea — write ≠ deploy.** Having GitHub write access does not mean you can deploy. Unless someone with the right Mocco role resumes the gate, the production deploy never obtains cloud credentials (OIDC/STS). That's why deleting the verify step doesn't bypass anything.

## Quickstart (local)

```bash
make application     # brew: mkcert traefik cloudflared node corepack
make initialize      # certs + /etc/hosts + tunnel + yarn install
make docker-up       # local Postgres
yarn db:migrate      # apply schema
yarn db:seed         # sample data (optional)
make dev             # https://mocco.work (traefik → Next :3100)
```

Details: [docs/guides/local-setup.md](./docs/guides/local-setup.md)

## Self-hosting

Mocco is self-hostable. Requirements: Node 22+, Postgres, a GitHub OAuth App (login) and a GitHub App (webhooks & dispatch). It deploys as a regular Next.js app — Vercel is not required. (A dedicated self-hosting guide is in progress; see the local setup guide in the meantime.)

## Structure

```
src/frontend/   @mocco/frontend  Next.js UI (app/api mounts the backend)
src/backend/    @mocco/backend   domain · db (Drizzle) · tRPC · handlers
src/common/     @mocco/common    shared zod schemas & types
docs/           llm-wiki (ADRs · concepts · guides) — start at docs/index.md
docs/prototype/ non-functional click-through (design validation)
```

## Development harness

- lint: **ESLint 10 flat** (airbnb-extended + typescript-eslint strict + unicorn + sonarjs), prettier
- test: Jest (backend, including pglite integration tests) · build: Next.js
- `make dev` / `yarn lint` / `yarn test` / `yarn format`
- Decision records: `docs/adr/`

## License

[AGPL-3.0](./LICENSE). Free to self-host, modify, and redistribute. If you offer Mocco as a network service, AGPL terms apply (source of your modifications must be made available). For commercial use where AGPL doesn't fit, contact us about a separate license.
