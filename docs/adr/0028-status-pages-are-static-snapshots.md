---
title: Public status pages are static snapshots on object storage
description: A status page is published as versioned static files (snapshot JSON, a pre-rendered HTML page, an Atom feed) to object storage behind a CDN, so reading it never touches the Mocco app or database; it is the deliberate exception to ADR 0015's ISR for public sites, because a status page has to stay up while Mocco or the customer's product is down.
type: adr
status: draft
created: 2026-10-04
updated: 2026-10-04
confidence: medium
owner: andrea
decision_date: 2026-10-04
stakeholders: [andrea]
tags: [adr, status-page, public-sites, object-storage, cdn, availability]
related:
  - ./0015-public-sites-use-isr-on-the-pages-router.md
  - ./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
  - ./0027-status-probes-are-pull-based-agents.md
  - ../specs/2026-09-24-status-page-design.md
  - ../reference/storage.md
---

# ADR 0028 — Public status pages are static snapshots on object storage

## Context

ADR 0015 serves public multi-tenant sites from the existing Next app with ISR: the first
request renders a page and caches it, and later requests get the cached HTML while it
regenerates. It names the status page as a later user of that pattern.

A status page has a requirement the help center doesn't: **it must keep serving when things
are broken.** That means when the customer's product is down, which is when the page gets
its traffic, and also when the Mocco app or its database is degraded. With ISR, a
regeneration runs a function that reads the database, and a request for a page the cache
has evicted waits on that function. The read path then depends on Vercel's runtime and our
database at exactly the moment the page matters. Self-hosting is affected too, because
serving the page would need `next start` running.

## Options

| Option | Read path depends on | Verdict |
|---|---|---|
| **A. ISR under `pages/_sites` (ADR 0015)** | The CDN cache, then a function and the database on regeneration or a cold path | Rejected for status. Fine for help centers, whose outage is an inconvenience rather than the failure they exist to report |
| **B. Static snapshots pushed to object storage behind a CDN** | Object storage and the CDN only | **Chosen** |
| **C. A third-party status host** | That vendor | Rejected. Incidents correlated with runs are the reason this product exists in Mocco |

## Decision

1. **Publishing is push.** Every change that affects a page (an incident update, a
   component status, a maintenance window, the daily uptime bars) marks the page dirty, and
   the `status.snapshot.publish` job (ADR 0014) builds a new version and uploads it. A
   five-minute safety run retries failed uploads. Builds are debounced per page, so twenty
   quick updates produce one or two versions, not twenty.
2. **A version is a set of immutable files.** `/{slug}/v/{version}/snapshot.json` (cached
   for a year), a pre-rendered `index.html` that shows the current state without
   JavaScript, `feed.atom`, and the pointer `/{slug}/current.json` (`max-age=15,
   stale-while-revalidate=60, stale-if-error=604800`). The page's script polls the pointer
   while the tab is visible and fetches the version it names. Publishing uploads the version
   first and flips the pointer last, so a reader never sees a half-written version.
3. **The files go through the storage domain's `ObjectStore` port**, under a dedicated
   public prefix: the `s3` driver for hosted (R2 or S3, with the CDN in front) and the
   `filesystem` driver for self-host, where any static server or CDN can serve the
   directory. The status domain gets a `StaticPublisher` over that port; it adds CDN purging
   of the pointer and nothing vendor-specific.
4. **The snapshot is an allowlist projection.** Only published incidents, public component
   data and public ids go in; no draft incidents, author emails or internal ids. The builder
   is the egress boundary, because nothing like a tRPC `.output()` sits on this path, and a
   test asserts a draft incident never appears in a snapshot.
5. **Hosts are mapped at the CDN.** `<slug>.status.mocco.club` and a customer's own domain
   point at the CDN, which maps the host to the page's prefix. The CDN origin is object
   storage, never the Vercel app, so a Vercel incident doesn't take status pages down. The
   mapping is configured as infrastructure, alongside the custom-domains foundation.
6. **The page's one dynamic call is subscribing.** The form posts to
   `/api/ext/v1/status-pages/:slug/subscribers`. If that fails, the form says to try later
   and the page itself keeps working.
7. **ADR 0015 is unchanged for every other public site.** Help centers, the forum and the
   changelog stay on ISR. A future public site uses this pattern only if it has the same
   requirement to outlive Mocco's own availability.

## Consequences

- A status page is readable when the Mocco app, its database and the customer's product are
  all down; it shows the last published version.
- An incident update takes as long to appear as a build plus an upload plus the pointer's
  15-second cache, a few seconds to about half a minute, rather than ISR's revalidation
  window.
- The page is plain HTML, CSS and a small script built by the backend, not a Next page. It
  can't reuse React components from the frontend. That is acceptable for a page this small,
  and it keeps self-hosted serving free of Node.
- The last twenty versions are kept in `mocco_status_page_snapshots`, so a page can be
  rolled back, and a self-hoster can rebuild the whole public directory from the database.
- Posting an incident while the Mocco app itself is down needs a separate path (building a
  version from the last snapshot and uploading it with a page-scoped credential). The
  design allows it but v1 doesn't build it.
