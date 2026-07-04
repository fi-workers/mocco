---
title: Frontend conventions (Next.js App Router)
type: reference
status: active
created: 2026-07-04
updated: 2026-07-04
confidence: high
owner: andrea
tags: [reference, frontend, nextjs, react, performance, lint]
---

# Frontend conventions (Next.js App Router)

> How `src/frontend` is written. Grounded in Next.js App Router guidance and Vercel's React performance rules. Lint enforces most of this — the rest is convention.

## Architecture

- **Server Components by default.** Everything in `app/` stays a Server Component unless it needs interactivity. Push `'use client'` to the **smallest leaf** that actually needs state/effects/handlers — never on layouts or data-heavy sections.
- **Fetch on the server.** Server Components call the backend directly (it's the same process — `@mocco/backend` is imported, not fetched over HTTP). Client-side fetching is the exception, not the rule.
- **Colocation.** A route owns its pieces: `app/<route>/page.tsx` + route-local components next to it. Only genuinely shared UI goes in a top-level shared folder (create it when the second consumer appears, not before).
- **Vendor isolation.** Third-party client SDKs are wrapped once (`lib/auth-client.ts` is the model: the only file importing the auth vendor, exporting neutral names). New vendors follow the same pattern.
- **Minimize the client payload.** Props crossing the server→client boundary are serialized — pass the fields a component needs, never whole records.

## Performance rules (top of the Vercel 45)

Priority order when writing or reviewing:

1. **No waterfalls** — independent awaits run through `Promise.all`; move `await` into the branch that uses it; use Suspense boundaries to stream.
2. **Bundle size** — no barrel-file imports (import the module, not the index); `next/dynamic` for heavy, rarely-shown components; defer third-party scripts until after hydration.
3. **Server work** — `React.cache()` for per-request dedup; keep serialization minimal.
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

`--max-warnings 0` — warnings are failures. If a rule must be silenced, disable the single line with a reason, never the rule globally.

## Current state

The login pages are `'use client'` by necessity (session hook + form state) — acceptable while the app is auth-only. The first data-heavy screen (deploy queue) must follow the RSC-first pattern above.
