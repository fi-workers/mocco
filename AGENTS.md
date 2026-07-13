# AGENTS.md

Context for AI coding agents working on this repository. Human-oriented docs live in [README.md](./README.md); the knowledge base starts at [docs/index.md](./docs/index.md).

## Project

Mocco is a **deploy governance control plane** on top of GitHub Actions. Core idea: **write ≠ deploy** — pipelines pause at gates, and only an authorized role can resume them; production deploys can't obtain cloud credentials (OIDC/STS) without a resumed, verified run. License: AGPL-3.0.

## Structure

```
packages/backend/   @mocco/backend   src/ — domain · infra · transport (see below)
packages/frontend/  @mocco/frontend  src/ — Next.js Pages Router UI (pages/api mounts the backend)
packages/common/    @mocco/common    src/ — shared types & zod schemas
docs/               llm-wiki: ADRs (immutable) · concepts · guides · reference · meta
docs/prototype/     non-functional click-through (design reference, plain HTML/JS)
infra/local/        traefik + mkcert for https://www.mocco.work local dev
```

- **Backend layering** (`packages/backend/src/`): `domain/` (Mocco's business logic — `auth/`, `pipeline/`, and each governance domain as it lands), `infra/` (replaceable plumbing with no business meaning — `db/`, `config/`), `transport/` (edges — `trpc/`, later Hono `ext/`). Dependency direction is one-way: `transport → domain → infra`. A new domain gets a folder under `domain/` when its slice lands — don't pre-create empty ones. `governance/`-style sub-grouping is added only once `domain/` is genuinely crowded. Vendor isolation stays at leaf files (`domain/auth/provider.ts`, `domain/pipeline/yaml/decode.ts`). The `@mocco/backend` export subpaths (`./auth/instance`, `./trpc/root`) are the stable public contract — repoint their targets on a move, don't rename the subpaths.
- Monorepo: yarn 4 workspaces (`packages/*`), Node 22 (`.nvmrc`). Each package keeps config at its root and source under `src/`.
- DB tables use the `mocco_` prefix; uuid PKs are generated in the DB (`defaultRandom()`).

## Setup & commands

```bash
corepack enable && yarn install   # deps (nodeLinker: node-modules)
make docker-up                    # local Postgres 16
yarn db:generate && yarn db:migrate

yarn test                         # vitest (backend) — includes pglite integration tests
yarn verify                       # every check, serially (same scripts CI runs) — REQUIRED green before any push (pre-push enforces)
yarn backend lint / ts-check      # per-workspace lint & typecheck
yarn format                       # prettier
make dev                          # https://www.mocco.work (traefik → Next :3100)
```

Tests must pass without docker: integration tests run on **pglite** (in-memory WASM Postgres) via `packages/backend/src/infra/db/testing/pglite.ts`, applying the real migrations. Prefer extending those over mocking the DB.

## Code style

- TypeScript strict; ESLint 10 flat config (airbnb-extended + typescript-eslint strictTypeChecked + unicorn + sonarjs) with `--max-warnings 0`; prettier formats everything.
- **All content in English** — code, comments, docs, commit messages, PR bodies.
- **Dependencies are pinned exactly** (no `^`/`~`). `yarn.lock` contains only the workspaces that exist on the branch.
- **Vendor isolation**: third-party services are wrapped behind neutral surfaces. Example: only `packages/backend/src/domain/auth/provider.ts` may import the auth library; everything else consumes the neutral services (`packages/backend/src/domain/auth/AuthService.ts`, `packages/backend/src/domain/auth/WorkspaceService.ts` — one cohesive file per service). Follow this pattern for new vendors. Env var names are ours (`AUTH_SECRET`), never vendor-branded.
- **API surfaces are thin adapters over services**: the frontend↔backend surface is tRPC (`/api/trpc`); the vendor auth surface is better-auth's own fetch handler (`/api/auth/[...all]`). A transport (a tRPC router, or a future REST route) carries no business logic — it parses at the boundary and delegates to the domain service, so no logic is duplicated across surfaces. Never expose tRPC to external/third-party consumers: external inbound (GitHub webhooks, any public API) gets its own REST surface, added when the need is real (E2b), and only a genuine public API is versioned (`/v1`) — webhooks are not.
- **Vendor failures become domain errors at the service**: interpreting vendor/DB error shapes (status codes, messages, pg constraint names) happens inside the service that owns the vendor boundary, which throws a domain error class colocated with the service (its own `errors.ts`) carrying the original as `cause`. Specific error classes extend a shared base in `domain/errors.ts` (e.g. `WorkspaceNotFoundError extends NotFoundError`). Each **router maps its own domain's errors** — a router-scoped middleware (composed onto `protectedProcedure`) matches the base via `instanceof` (`NotFoundError → NOT_FOUND`) and reuses it across that router's procedures. The transport core (`trpc.ts`) stays generic — it never accumulates domain error knowledge. Never sniff vendor error strings outside the service. When a domain's mapping repeats across its procedures, that's the trigger to declare its router-scoped middleware; keep the specific classes colocated per domain.
- **Env access is centralized** (lint-enforced in the backend): `packages/backend/src/infra/config/env.ts` is the only `process.env` reader — a lazy, zod-validated surface (`getEnv()`). Never read `process.env` inline; add new vars to the schema.
- **No test-only code in production modules**: no `*ForTesting` hooks, seams, or swappable singletons. Services are constructor-injected classes (`new AuthService(provider)`, `new WorkspaceService(provider)`); a composition root binds them once (`auth/instance.ts`), and tests construct the same classes over pglite. Never static classes importing singletons — explicit constructor arguments are the seam; hoisted module-mocking (`vi.mock`) is not a substitute (ADR 0008). If a test can't reach something, fix the design (inject the dependency), don't add a seam.
- **Derive types from values** (has-a, not is-a): prefer `z.infer` / `ReturnType<typeof factory>` over hand-maintained parallel interfaces. Write explicit type annotations only where they pin a boundary (e.g. neutral return types inside `auth/service.ts` that stop vendor inference from leaking).
- **No index/barrel files** (lint-enforced): never create `index.ts` re-export hubs (FSD-style). Name modules concretely and import the concrete path; cross-package consumers go through explicit `package.json` `exports` subpaths (e.g. `@mocco/backend/trpc/handler`).
- **Constants over enums & magic strings** (lint-enforced): no TS `enum`/`const enum` — model a fixed set as an `as const` object with a derived union type (`export const Statuses = { Active: 'Active', … } as const; export type Status = (typeof Statuses)[keyof typeof Statuses];`). Plural const name, singular type name; keys match their values unless an external contract dictates the casing (parse external raw values only at the boundary). Never compare against a raw domain string — reference the exported constant (`x === Statuses.Active`). Define each domain constant once (single source of truth) and import it; don't duplicate. `enum` is allowed only when an external library/SDK requires it. Every control statement takes braces (`curly: all`).

## PR conventions

Full workflow: [docs/guides/pr-workflow.md](./docs/guides/pr-workflow.md) — or invoke the `/pr` skill (`.claude/skills/pr/SKILL.md`), which is the executable version.

- **Small PRs, one concern each**, in dependency order. Keep every PR installable and green on a fresh clone.
- **PR bodies explain the _why_, not just the _what_** — a `## Why` section covering the problem solved, the benefit, why this approach over alternatives, and the trade-offs (link an ADR for larger decisions). The reviewer should never have to reconstruct the rationale from the diff. See the body shape in the `/pr` skill.
- **Stage explicit paths only** — never `git add -A`/`git add .`; the shared working tree may hold unrelated files.
- **Feedback auto-promotion**: when review feedback states or implies a reusable rule, the agent must promote it immediately to the strongest layer — lint rule > test > AGENTS.md > skill/docs — in the same session, and say so. Don't rely on memory.
- Conventional-commit style titles (`feat:`, `chore:`, `docs:`, `ci:`).
- Each schema change ships its own drizzle migration; migration history tracks PR order.
- Update the relevant `docs/reference/` page when behavior changes; ADR bodies are immutable (supersede with a new ADR).
- Backend code follows [docs/reference/backend-conventions.md](./docs/reference/backend-conventions.md) — layered `domain`/`infra`/`transport` (one-way deps), vendor isolation at leaf files, constructor-injected services (no seams), domain errors mapped to transport codes **per router** (shared base in `domain/errors.ts`, router-scoped `protected*Procedure` middleware — `trpc.ts` stays generic).
- Frontend code follows [docs/reference/frontend-conventions.md](./docs/reference/frontend-conventions.md) — **Pages Router** (`pages/`, see [ADR 0009](./docs/adr/0009-frontend-uses-the-pages-router.md)), **client-rendered (no SSR)**: SSG landing, `@trpc/react-query` data, a client-side auth guard on better-auth `useSession`, shadcn/ui + neutral tokens, `@/` absolute imports; lint enforces Next CWV + jsx-a11y strict + @eslint-react type-checked.
- **React Compiler is ON** — never hand-write `useMemo`/`useCallback`/`React.memo`. Effect callbacks are arrow functions (lint's `prefer-arrow-callback`); client redirects in effects go through `fire-and-forget.ts` to keep the strict promise lints clean.
- **Parse, don't validate**: external data (API/webhook/URL/storage) crosses boundaries only via zod `safeParse`; domain ids use `.brand<'GitSha'>()`-style branded types; `as` only inside parsers.
- **URL is state**: shareable view state (filters/tabs/ranges) lives in `searchParams`, not component state.
- CI workflows follow [docs/reference/ci-conventions.md](./docs/reference/ci-conventions.md) — SHA-pinned actions, no `pull_request_target`, no cross-boundary caches, minimal `permissions`.

## Key decisions (read before large changes)

- [ADR 0002](./docs/adr/0002-mocco-is-an-independent-authorization-layer.md) — Mocco is an independent authorization layer; GitHub only links identity.
- [ADR 0003](./docs/adr/0003-core-model-is-pause-resume-gates-no-env.md) — the core model is pause/resume gates, not environments.
- [ADR 0004](./docs/adr/0004-executor-agnostic-core-with-adapter-contract.md) — executor-agnostic core; GitHub Actions is one adapter.
- Feature scope: [docs/reference/feature-map.md](./docs/reference/feature-map.md) (MVP vs post-MVP).
