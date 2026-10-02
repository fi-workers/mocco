---
title: Public multi-tenant sites use ISR on the Pages Router
description: Help centers (and later the status page, forum and changelog) are served by the existing Next app under pages/_sites/**, picked by Host through a next.config rewrite, statically generated on first request with background regeneration (ISR); getServerSideProps stays banned and the pages read only through public-read domain services.
type: adr
status: draft
created: 2026-10-02
updated: 2026-10-02
confidence: medium
owner: andrea
decision_date: 2026-10-02
stakeholders: [andrea]
tags: [adr, frontend, nextjs, isr, public-sites, help-center]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ./0009-frontend-uses-the-pages-router.md
  - ./0017-public-v1-api-keys-and-sdk-licensing.md
  - ../specs/2026-09-24-help-center-design.md
  - ../reference/help-center.md
---

# ADR 0015 — Public multi-tenant sites use ISR on the Pages Router

## Context

The frontend renders the landing and the customer guides statically and the app on the client; nothing renders per request (ADR 0009). The help center (#96), and later the status page (#103), forum (#97) and changelog (#98), are different: they are many sites, one per customer, picked by the request's host; they must be crawlable and fast on first paint; and their content changes whenever the customer publishes, without a deploy.

## Options

| Option | For | Against |
|---|---|---|
| **A. ISR pages in the existing Next app** (`pages/_sites/[site]/...`, a host rewrite, `getStaticProps` with `revalidate`) | One deployment (ADR 0005); domain services are called in-process; HTML is cached at the CDN; the Vercel multi-tenant pattern | Server data code in the frontend; a self-hosted install with several instances needs a shared ISR cache |
| B. A separate public app (`packages/sites`) | Isolation, its own bundle and headers | A second deployment and pipeline; duplicated config |
| C. The Hono ext app renders HTML strings with cache headers | Framework-free, the same everywhere | Re-implements layout and components; CDN purging differs per host |

## Decision

**A.** Public multi-tenant surfaces live under `pages/_sites/**`:

1. **Host routing** is a `beforeFiles` rewrite in `next.config.ts`: `<site>.<HELP_SITES_DOMAIN>/<path>` → `/_sites/<site>/<path>`, excluding `/_next/` and `/api/`. Custom domains (a later slice) add their own host → site lookup.
2. **Rendering** is `getStaticProps` + `getStaticPaths({ paths: [], fallback: 'blocking' })` with `revalidate` (60 seconds for help centers): the first request renders and caches the page, later requests get the cached HTML while it regenerates in the background. **`getServerSideProps` remains banned.**
3. **Data** comes only from a public-read domain service (for the help center, `HelpPublicReadService`): published content only, no operator session, no tRPC. Interactive parts (search, feedback) will be client fetches to `/v1`.
4. **Markdown** becomes the frontend's render tree (`lib/markdown-blocks.ts`, shared with the customer guides) on the server; the browser gets React elements, never an HTML string, and raw HTML in content renders as text.
5. **On-demand revalidation** on publish is a later step: a secret-guarded Pages API route calling `res.revalidate` on the rewritten `/_sites/...` paths.

## Consequences

- No new deployment; a help center works on the Mocco host as soon as `HELP_SITES_DOMAIN` is set and the wildcard domain points at the deployment.
- A publish shows up within the revalidation window until on-demand revalidation lands.
- Self-hosting on one `next start` instance works with the filesystem ISR cache; several instances need a shared `cacheHandler` (documented when self-hosting is).
- The pages under `_sites` are also reachable on the Mocco host as `/_sites/<site>/...`; their links assume the site's own host.
