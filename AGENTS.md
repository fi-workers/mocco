# AGENTS.md

Context for AI coding agents working on this repository. Human-oriented docs live in [README.md](./README.md); the knowledge base starts at [docs/index.md](./docs/index.md).

## Project

Mocco is a **deploy governance control plane** on top of GitHub Actions. Core idea: **write ≠ deploy** — pipelines pause at gates, and only an authorized role can resume them; production deploys can't obtain cloud credentials (OIDC/STS) without a resumed, verified run. License: AGPL-3.0.

## Structure

```
src/backend/    @mocco/backend   domain · db (Drizzle/Postgres) · auth · handlers
src/frontend/   @mocco/frontend  Next.js UI (app/api mounts the backend)
src/common/     @mocco/common    shared types & zod schemas (not landed yet)
docs/           llm-wiki: ADRs (immutable) · concepts · guides · reference · meta
docs/prototype/ non-functional click-through (design reference, plain HTML/JS)
infra/local/    traefik + mkcert for https://mocco.work local dev
```

- Monorepo: yarn 4 workspaces, Node 22 (`.nvmrc`).
- DB tables use the `mocco_` prefix; uuid PKs are generated in the DB (`defaultRandom()`).

## Setup & commands

```bash
corepack enable && yarn install   # deps (nodeLinker: node-modules)
make docker-up                    # local Postgres 16
yarn db:generate && yarn db:migrate

yarn test                         # jest (backend) — includes pglite integration tests
yarn backend lint / ts-check      # per-workspace lint & typecheck
yarn format                       # prettier
make dev                          # https://mocco.work (traefik → Next :3100)
```

Tests must pass without docker: integration tests run on **pglite** (in-memory WASM Postgres) via `src/backend/db/testing/pglite.ts`, applying the real migrations. Prefer extending those over mocking the DB.

## Code style

- TypeScript strict; ESLint 10 flat config (airbnb-extended + typescript-eslint strictTypeChecked + unicorn + sonarjs) with `--max-warnings 0`; prettier formats everything.
- **All content in English** — code, comments, docs, commit messages, PR bodies.
- **Dependencies are pinned exactly** (no `^`/`~`). `yarn.lock` contains only the workspaces that exist on the branch.
- **Vendor isolation**: third-party services are wrapped behind neutral surfaces. Example: only `src/backend/auth/provider.ts` may import the auth library; everything else uses `authHandler`/`getSession` from `src/backend/auth`. Follow this pattern for new vendors. Env var names are ours (`AUTH_SECRET`), never vendor-branded.

## PR conventions

Full workflow: [docs/guides/pr-workflow.md](./docs/guides/pr-workflow.md) — or invoke the `/pr` skill (`.claude/skills/pr/SKILL.md`), which is the executable version.

- **Small PRs, one concern each**, in dependency order. Keep every PR installable and green on a fresh clone.
- **Feedback auto-promotion**: when review feedback states or implies a reusable rule, the agent must promote it immediately to the strongest layer — lint rule > test > AGENTS.md > skill/docs — in the same session, and say so. Don't rely on memory.
- Conventional-commit style titles (`feat:`, `chore:`, `docs:`, `ci:`).
- Each schema change ships its own drizzle migration; migration history tracks PR order.
- Update the relevant `docs/reference/` page when behavior changes; ADR bodies are immutable (supersede with a new ADR).
- Frontend code follows [docs/reference/frontend-conventions.md](./docs/reference/frontend-conventions.md) — RSC-first, `'use client'` at leaves, no waterfalls, bundle discipline; lint enforces Next CWV + jsx-a11y strict + @eslint-react type-checked.
- **React Compiler is ON** — never hand-write `useMemo`/`useCallback`/`React.memo`. Name effect callbacks (`useEffect(function syncX() {…})`).
- **Parse, don't validate**: external data (API/webhook/URL/storage) crosses boundaries only via zod `safeParse`; domain ids use `.brand<'GitSha'>()`-style branded types; `as` only inside parsers.
- **URL is state**: shareable view state (filters/tabs/ranges) lives in `searchParams`, not component state.
- CI workflows follow [docs/reference/ci-conventions.md](./docs/reference/ci-conventions.md) — SHA-pinned actions, no `pull_request_target`, no cross-boundary caches, minimal `permissions`.

## Key decisions (read before large changes)

- [ADR 0002](./docs/adr/0002-mocco-is-an-independent-authorization-layer.md) — Mocco is an independent authorization layer; GitHub only links identity.
- [ADR 0003](./docs/adr/0003-core-model-is-pause-resume-gates-no-env.md) — the core model is pause/resume gates, not environments.
- [ADR 0004](./docs/adr/0004-executor-agnostic-core-with-adapter-contract.md) — executor-agnostic core; GitHub Actions is one adapter.
- Feature scope: [docs/reference/feature-map.md](./docs/reference/feature-map.md) (MVP vs post-MVP).
