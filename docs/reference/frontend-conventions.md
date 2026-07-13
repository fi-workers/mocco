---
title: Frontend conventions (Next.js Pages Router, client-rendered)
description: How packages/frontend is written — a client-rendered app (no SSR) on the Pages Router with an SSG landing, @trpc/react-query data, a client-side auth guard, shadcn/ui + neutral tokens, @/ absolute imports, React Compiler, parse-don't-validate, URL-as-state, and the fetch-to-Node API bridges.
type: reference
status: active
created: 2026-07-04
updated: 2026-07-13
confidence: high
owner: andrea
tags: [reference, frontend, nextjs, react, csr, react-query, performance, lint]
---

# Frontend conventions (Next.js Pages Router, client-rendered)

> How `packages/frontend` is written. The app uses the **Pages Router** (`pages/`) — see [ADR 0009](../adr/0009-frontend-uses-the-pages-router.md) — but **no SSR**: the landing is statically generated and the authenticated app renders on the client. Lint enforces most of this; the rest is convention.

## Adopted patterns

- **No SSR — SSG landing, CSR app.** No page uses `getServerSideProps`. The public landing (`/`) is statically generated; everything behind auth renders on the client. This is a deliberate product call: simpler deploy, no server data-fetching, at the cost of a brief loading state on authed pages.
- **React Compiler is ON** (`next.config.ts: reactCompiler`). Do NOT hand-write `useMemo` / `useCallback` / `React.memo` — the compiler owns memoization. The strict `react-hooks` lint keeps it safe. Effect callbacks are **arrow functions** (`prefer-arrow-callback`).
- **Client data through React Query.** All reads/writes go through `@trpc/react-query` hooks — never a vanilla client call in a component. Loading and error states are the query's, not hand-rolled.
- **Client-side auth guard.** Gated surfaces check better-auth's `useSession`: while it's pending, render a spinner; if there's no session, redirect to sign-in. There is no server-side gate.
- **Parse, don't validate.** Every external boundary (API responses, URL params, storage) goes through zod `safeParse`; reuse the `@mocco/common` schemas so client validation matches the server. `as` casts live only inside parsers; `any`/`@ts-ignore` are lint errors.
- **URL is state.** Shareable view state (the active workspace is the `[id]` in the path; filters/tabs/`?create` in the query) lives in the URL. Rule of thumb: "if someone opens this URL, must they see the same screen?" Never put secrets/ephemeral UI state in the URL. `push` for undoable steps, `replace` for redirects and live typing.

## Architecture

- **Pages Router.** Routes are files under `pages/` (`pages/index.tsx` = home, `pages/workspaces/[id]/settings.tsx` = a workspace's settings). Shared UI in `components/`; helpers in `lib/`. `_app.tsx` wraps every page; `_document.tsx` owns the `<html>`/`<body>` shell.
- **Data: `@trpc/react-query` + TanStack Query.** `lib/trpc.ts` is `createTRPCReact<AppRouter>()`; `_app.tsx` creates the `QueryClient` + tRPC client (httpBatchLink, superjson) once and wires `trpc.Provider` + `QueryClientProvider`. Components read via `trpc.x.useQuery(...)` and write via `trpc.x.useMutation(...)`. React Query dedupes and caches, so sibling components can each call the same query without waterfalls; invalidate (`trpc.useUtils()`) after a mutation to refresh dependent surfaces.
- **Auth: a client guard on `useSession`.** `AppShell` (and the `/workspaces` router) redirect to `/auth/sign-in` when there's no session and show a spinner while it loads. There is no `getServerSideProps` / `withAuth`. **After sign-in/up, navigate with a full load** (`globalThis.location.assign`), not a client `push` — better-auth's `useSession` doesn't refetch after an in-page sign-in, so the destination must read the freshly-set cookie on a fresh page.
- **Shell & workspace routing.** `AppShell` is a slim Vercel-style top bar (logo + workspace switcher + user menu) that **fetches its own** session + workspaces. Inside a workspace, `WorkspaceLayout` adds the left nav (Overview / Members / Settings) around the section content. Workspace-scoped routes: `/workspaces/[id]` (dashboard) and `/workspaces/[id]/{members,settings}`. Visiting one makes it active server-side (`setActive`, which also validates membership). `/workspaces` is a router, not a list — it jumps into a workspace when one exists (`?create` or zero shows the focused create view).
- **Fire-and-forget navigation.** Client redirects inside effects/mutation callbacks go through `lib/fire-and-forget.ts` — it holds the intentional floating promise in one place so the strict promise lints stay clean.
- **UI: shadcn/ui + neutral tokens.** Primitives live in `components/ui/` (shadcn's `base-nova` style, built on `@base-ui/react`), composed with the `cn` util and styled via the design-token CSS variables (`bg-primary`, `text-muted-foreground`, `border-border`, …) — not raw palette classes. Icons from `lucide-react`.
- **Absolute imports.** Cross-directory imports use the `@/` alias (`@/lib`, `@/components/...`); climbing `../` is a lint error (`no-restricted-imports`). Same-directory `./` siblings stay relative. Cross-package still uses `@mocco/*`.
- **API routes bridge to the backend's neutral handlers.** `pages/api/auth/[...all].ts` mounts `getServices().auth.nodeHandler`; `pages/api/trpc/[trpc].ts` uses tRPC's Next handler. The fetch→Node bridges live behind the backend's vendor boundary (see ADR 0009).
- **Vendor isolation.** Third-party client SDKs are wrapped once — `lib/auth-client.ts` (the only file importing the auth vendor, exporting neutral names) and `lib/monitoring.ts` (the only `@sentry/nextjs` importer, lint-enforced). New vendors follow the same pattern.

## Performance rules

Priority order when writing or reviewing:

1. **No waterfalls** — independent awaits in a handler run through `Promise.all`; independent queries are separate `useQuery` hooks (React Query fetches them in parallel and dedupes).
2. **Bundle size** — no barrel-file imports (import the module, not the index); `next/dynamic` for heavy, rarely-shown components; defer third-party scripts until after hydration.
3. **Re-renders** — functional `setState` for stable callbacks; don't subscribe to state only read inside callbacks; let the React Compiler memoize (don't hand-roll it).
4. Ternary (`cond ? a : b`) over `&&` for conditional JSX.

## Lint stack (enforced)

| Layer | What it covers |
|---|---|
| base (`eslint.config.base.mjs`) | typescript-eslint strictTypeChecked · airbnb-extended · unicorn · sonarjs |
| `@next/eslint-plugin-next` core-web-vitals | Next.js pitfalls (img/font/script/link misuse) |
| `eslint-plugin-react-hooks` v7 `recommended-latest` | rules-of-hooks + React Compiler-powered diagnostics |
| `@eslint-react` `recommended-type-checked` | modern type-aware React rules (replaces eslint-plugin-react, which lacks ESLint 10 support) |
| `eslint-plugin-jsx-a11y` strict | accessibility |
| `react-doctor` (`--blocking error`) | Next.js/React anti-patterns as a separate CI leg; errors block, advisory warnings don't |

`--max-warnings 0` — warnings are failures. If a rule must be silenced, disable the single line with a reason, never the rule globally.

- **`@/` absolute imports**: `no-restricted-imports` bans `../` parent climbs; reach across directories via `@/`.
- **Vendored `components/ui/`**: shadcn primitives are formatted to the repo style; two React-hostile rules (`unicorn/no-declarations-before-early-exit`, `sonarjs/function-return-type`) are off for `src/{pages,components}/**` because hooks must precede early returns and a component legitimately returns a spinner in one branch and content in another.
- `pages/**/index.{ts,tsx}` is exempt from the no-barrel rule (route files are named by the router, not re-export hubs).

## Current state

Every authenticated surface is client-rendered: `AppShell` guards the session and fetches the shell data; pages read/write through React Query; the workspace area (dashboard, members, settings) lives under `/workspaces/[id]`. The only server code left in the frontend is the two API-route bridges that mount the backend. Repos on the dashboard are a "Connect GitHub" placeholder until the GitHub App slice lands.
