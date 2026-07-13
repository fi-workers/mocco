---
title: Frontend uses the Pages Router
description: Migrates the frontend from the App Router to the Next.js Pages Router, bridging the backend's fetch handlers to Node API routes at the vendor boundary.
type: adr
status: accepted
created: 2026-07-11
updated: 2026-07-11
confidence: high
owner: andrea
tags: [adr, frontend, nextjs, pages-router]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ../reference/frontend-conventions.md
---

# 9. Frontend uses the Pages Router

Date: 2026-07-11

## Status

Accepted. Reverses the implicit App Router choice under [ADR 0005](./0005-tech-stack-vercel-native-next-fullstack.md) (stack stays Next.js on Vercel; only the router paradigm changes).

## Context

The frontend shipped on the Next.js **App Router** (`app/`, React Server
Components, route handlers, RSC-first conventions). The maintainer prefers the
**Pages Router** paradigm — page-centric, no server/client component boundary
to reason about, familiar `getServerSideProps`-style data flow.

The backend exposes its two HTTP surfaces as **fetch handlers**
(`(Request) => Promise<Response>`): `AuthService.handler` (better-auth) and
`trpcHandler` (tRPC fetch adapter). These were shaped for the App Router, whose
route handlers are Web-standard. Pages Router API routes are **Node**
(`(req: NextApiRequest, res: NextApiResponse)`), so the surfaces must be
bridged. The DB layer (node-postgres) rules out the Edge runtime, so the API
routes run on Node and cannot mount the fetch handlers directly.

## Decision

Migrate the frontend to the Pages Router (`src/frontend/pages/`).

- **Routing**: `app/layout.tsx` → `pages/_app.tsx` (+ `_document.tsx` for
  `<html lang>`); `app/page.tsx` → `pages/index.tsx`; `app/account/page.tsx` →
  `pages/account.tsx`. Delete `app/` — no dual-router tree.
- **API routes bridge fetch handlers to Node, at the vendor boundary**:
  - Auth: a node handler built with better-auth's own `toNodeHandler`
    (`better-auth/node`), placed in the auth module (the only place allowed to
    import the vendor) — not hand-rolled, so cookie/body/stream handling is the
    vendor's tested path.
  - tRPC: tRPC's own `createNextApiHandler` (`@trpc/server/adapters/next`) with
    a context builder shared with the existing fetch handler (session read from
    Node headers via a small header adapter). tRPC is not the auth vendor, so
    using its native adapter keeps the two vendors' bridges independent.
  - Both routes set `export const config = { api: { bodyParser: false } }` — the
    handlers read the raw request body themselves.
- **Data fetching stays client-side** via a typed vanilla tRPC client
  (`lib/trpc.ts`), consistent with the auth pages, which are already client
  components (better-auth `useSession` is a client hook). This migration does
  not add `getServerSideProps` data loading; that can come later per page.

## Consequences

- **Lost**: React Server Components, streaming, and the RSC-first layering.
  `docs/reference/frontend-conventions.md` and the AGENTS.md frontend rules are
  rewritten for the Pages Router; the "RSC-first / `'use client'` at leaves"
  guidance no longer applies.
- **Vendor isolation preserved**: the fetch→Node bridges live behind the vendor
  boundaries (auth module; tRPC adapter), so pages/API routes still consume
  neutral handlers.
- Next.js positions the App Router as its default and the Pages Router as
  stable-but-legacy; new Next features may land App-Router-first. Accepted as a
  deliberate trade for the simpler page-centric model.
- React Compiler stays on (paradigm-independent).
