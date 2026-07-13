---
title: Frontend conventions (Next.js Pages Router)
description: How packages/frontend is written under the Pages Router — React Compiler, server data via getServerSideProps, parse-don't-validate, URL-as-state, and the fetch-to-Node API bridges.
type: reference
status: active
created: 2026-07-04
updated: 2026-07-11
confidence: high
owner: andrea
tags: [reference, frontend, nextjs, react, performance, lint]
---

# Frontend conventions (Next.js Pages Router)

> How `packages/frontend` is written. The app uses the **Pages Router** (`pages/`) — see [ADR 0009](../adr/0009-frontend-uses-the-pages-router.md). Lint enforces most of this; the rest is convention.

## Adopted patterns

- **React Compiler is ON** (`next.config.ts: reactCompiler`). Do NOT hand-write `useMemo` / `useCallback` / `React.memo` — the compiler owns memoization. The strict `react-hooks` lint is the prerequisite that keeps it safe.
- **Prefer server data over effects.** Auth gates and initial page data go through `getServerSideProps` (runs on the server, calls `@mocco/backend` directly — same process, not fetched over HTTP). Client-side loading in `useEffect` trips `react-hooks/set-state-in-effect`; reach for it only for data that genuinely can't be known at request time. Effect callbacks are **arrow functions** (`prefer-arrow-callback`).
- **Parse, don't validate.** Every external boundary (API responses, webhooks, URL params, storage) goes through zod `safeParse`. Domain identifiers are branded — `z.string().brand<'GitSha'>()` etc. — so mixed-up arguments fail at compile time. `as` casts live only inside parsers; `any`/`@ts-ignore` are lint errors.
- **URL is state.** Shareable view state (filters, tabs, time ranges, sort, pagination) lives in the query string (`router.query`). Rule of thumb: "if someone opens this URL, must they see the same screen?" Never put secrets/ephemeral UI state in the URL. `push` for undoable steps, `replace` (debounced) for live typing.

## Architecture

- **Pages Router.** Routes are files under `pages/` (`pages/index.tsx` = home, `pages/account.tsx` = `/account`). Shared UI lives in `components/`; helpers in `lib/`. `_app.tsx` wraps every page (global CSS, `<Head>`); `_document.tsx` owns the `<html>`/`<body>` shell.
- **Server data via `getServerSideProps`.** It reads the session (`getServices().auth.getSession(headersFromNode(req.headers))`), redirects unauthenticated requests (`{ redirect: … }`), and loads initial data through the tRPC server caller (`appRouter.createCaller(ctx)`) so pages arrive populated. Props must be JSON-serializable — map to the fields the page needs (no `Date`s, no whole vendor rows).
- **Client interactivity via a vanilla tRPC client.** `lib/trpc.ts` (`createTRPCClient<AppRouter>`, superjson) drives mutations and refetches from event handlers. `setState` in a handler is fine; `setState` synchronously in an effect is not.
- **API routes bridge to the backend's neutral handlers.** `pages/api/auth/[...all].ts` mounts `getServices().auth.nodeHandler`; `pages/api/trpc/[trpc].ts` uses tRPC's `createNextApiHandler`. Both set `config.api.bodyParser = false` where the handler reads the raw body. The fetch→Node bridges live behind the backend's vendor boundary (see ADR 0009).
- **Vendor isolation.** Third-party client SDKs are wrapped once (`lib/auth-client.ts` is the model: the only file importing the auth vendor, exporting neutral names). New vendors follow the same pattern.
- **Minimize the client payload.** Props crossing the server→client boundary are serialized — pass the fields a component needs, never whole records.

## Performance rules (top of the Vercel 45)

Priority order when writing or reviewing:

1. **No waterfalls** — independent awaits (in `getServerSideProps` or handlers) run through `Promise.all`.
2. **Bundle size** — no barrel-file imports (import the module, not the index); `next/dynamic` for heavy, rarely-shown components; defer third-party scripts until after hydration.
3. **Server work** — keep `getServerSideProps` lean; serialize minimally.
4. **Re-renders** — functional `setState` for stable callbacks; don't subscribe to state only read inside callbacks; memoize genuinely expensive subtrees only.
5. Ternary (`cond ? a : b`) over `&&` for conditional JSX.

## Lint stack (enforced)

| Layer | What it covers |
|---|---|
| base (`eslint.config.base.mjs`) | typescript-eslint strictTypeChecked · airbnb-extended · unicorn · sonarjs |
| `@next/eslint-plugin-next` core-web-vitals | Next.js pitfalls (img/font/script/link misuse) |
| `eslint-plugin-react-hooks` v7 `recommended-latest` | rules-of-hooks + React Compiler-powered diagnostics |
| `@eslint-react` `recommended-type-checked` | modern type-aware React rules (replaces eslint-plugin-react, which lacks ESLint 10 support) |
| `eslint-plugin-jsx-a11y` strict | accessibility |
| `react-doctor` (`--blocking error`) | Next.js/React anti-patterns as a separate CI leg; errors block, advisory warnings don't |

`--max-warnings 0` — warnings are failures. If a rule must be silenced, disable the single line with a reason, never the rule globally. `pages/**/index.{ts,tsx}` is exempt from the no-barrel rule (route files are named by the router, not re-export hubs).

## Current state

The pages are client components by necessity (better-auth's `useSession` is a client hook; forms hold local state). `/account` gates and loads its data server-side in `getServerSideProps` (the model for the next data screens — the deploy queue follows the same shape).
