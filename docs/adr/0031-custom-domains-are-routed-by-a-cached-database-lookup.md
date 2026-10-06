---
title: Custom domains are routed by a cached database lookup in the proxy
description: A domain a customer adds at runtime is routed by Next's proxy, which maps the request host to a site through a short in-memory cache over mocco_domains rather than an Edge Config mirror; ownership is proven with Mocco's own TXT record before anything is attached, attaching goes through a DomainProvisioner port (vercel and manual first, caddy later), a hostname belongs to one surface of one project, and status pages share the table and verification but keep their CDN host mapping.
type: adr
status: draft
created: 2026-10-05
updated: 2026-10-05
confidence: medium
owner: andrea
decision_date: 2026-10-05
stakeholders: [andrea]
tags: [adr, custom-domains, routing, public-sites, help-center, status-page, self-hosting]
related:
  - ./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
  - ./0015-public-sites-use-isr-on-the-pages-router.md
  - ./0018-domain-events-vs-audit-log.md
  - ./0028-status-pages-are-static-snapshots.md
  - ../reference/help-center.md
  - ../reference/env.md
---

# ADR 0031 — Custom domains are routed by a cached database lookup in the proxy

## Context

A help center is served on a customer's own domain today through `HELP_CUSTOM_DOMAINS`, which
`next.config.ts` turns into one host rewrite per domain at build time. Adding a domain means
editing an environment variable, adding the domain to the Vercel project by hand and
redeploying. Custom domains (#120) have to work from the console: a customer adds
`help.example.com`, points DNS at Mocco, and the site is served there a few minutes later
with no deploy.

Build-time rewrites can't do that, so the host has to be resolved per request. The question
is where the host → site table lives at request time. The domains themselves live in
`mocco_domains` (#425) whatever we choose, because verification, conflicts, the audit log and
the console all need them in the database.

## Options

| Option | Read path | Verdict |
|---|---|---|
| **A. Vercel Edge Config mirrored from `mocco_domains`** | An Edge Config read (sub-millisecond, at the edge) | Rejected. A second copy of the table that every add, verify and removal must also write, plus a reconcile job for when they drift, and a routing path that only exists on Vercel |
| **B. The proxy reads `mocco_domains` through an in-memory cache** | The instance's cache; on a miss, one indexed query by hostname | **Chosen** |
| **C. Keep build-time rewrites and redeploy on every change** | None (static rewrites) | Rejected. Minutes per change, a deploy per customer action, and a rewrite list that grows with every customer |

Option A's speed matters less than it looks. Domains change rarely, so a cache with a
one-minute lifetime answers almost every request from memory, and the cold path is a single
query on a unique index. Self-hosting decides it: the `manual` and `caddy` drivers (#426,
#429) exist so Mocco runs off Vercel, and routing that needs Edge Config would undo that.

## Decision

1. **Routing is a proxy (`proxy.ts`, Next 16) on the Node runtime.** It runs before the
   rewrites in `next.config.ts`. Mocco's own hosts (the app, the API host,
   `<slug>.<HELP_SITES_DOMAIN>`) are recognised without a lookup. Any other host is resolved
   through `DomainService.resolveHost(hostname)`, and an active help-center domain rewrites to
   `/_sites/<slug>/<path>`, as the build-time rewrite does today. The same paths stay excluded
   (`_next/`, `api/`, `favicon`, and the robots, sitemap, agents and OG routes, which already
   resolve the host themselves through `helpSiteForHost`).
2. **The resolver sits behind a small `HostResolver` interface** with one implementation: a
   per-instance, size-bounded cache over the database. Hits are kept for 60 seconds, and so
   are misses, so a scan of random hosts doesn't turn into queries. A domain change in the
   same instance evicts its entry immediately. If measured latency ever calls for it, Edge
   Config can be added as a second implementation without touching the callers.
3. **The Mocco subdomain redirects to the custom domain.** When a site has an active custom
   domain, a request to `<slug>.<HELP_SITES_DOMAIN>` gets a 308 to the same path on the custom
   domain, from the same cache (keyed by slug). Canonical URLs, sitemaps and OG cards follow
   from `helpSiteOrigin`, which reads `mocco_domains` instead of `HELP_CUSTOM_DOMAINS`.
4. **Ownership is proven with Mocco's own TXT record before anything is attached.** Adding a
   domain issues a token, and the customer publishes it as `_mocco-challenge.<hostname>`. A
   verification job (ADR 0014) checks it with backoff, and only a verified domain is handed
   to the provisioner. If Vercel then reports the domain as in use by another Vercel account,
   the console shows the extra TXT record Vercel asks for; Mocco doesn't try to resolve that
   itself.
5. **Attaching is a `DomainProvisioner` port.** `register(hostname)`, `status(hostname)`
   (DNS configured, certificate issued) and `unregister(hostname)`. The `vercel` driver
   (Domains API on the production project) and the `manual` driver (the operator attaches the
   domain; Mocco only tracks verification) ship first. The `caddy` driver (on-demand TLS with
   an ask endpoint that consults `mocco_domains`) comes later. A domain becomes `active` only
   when the provisioner reports both DNS and the certificate as ready, so the proxy never
   routes a host that can't serve HTTPS.
6. **A hostname belongs to one surface of one project.** `mocco_domains` has a unique index
   on the hostname over rows that aren't removed, and each row names its surface (`help`,
   `status`, `links`) and target. Adding a hostname that is pending or active anywhere else is
   refused; the console says so without naming the other project. Subdomains are the
   documented path (a CNAME). An apex domain works with the provider's A record, and `www`
   redirects aren't part of v1.
7. **Status pages share the table, verification and provisioning, not the routing.** Per ADR
   0028 a status page is served by the CDN from object storage, never by the app, so its
   custom domain is mapped at the CDN, and its provisioner driver targets the CDN rather than
   the Vercel project. The proxy ignores `status` rows. The status-page work (#157) owns that
   driver.
8. **Limits.** The hosted service caps domains per project with a config value
   (`CUSTOM_DOMAINS_MAX_PER_PROJECT`, default 1 per surface), and the operator watches the
   Vercel project's own domain limit: the `vercel` driver reports the count, and adding a
   domain is refused with a clear message when Vercel refuses it. Per-plan limits wait for
   billing.

## Consequences

- A customer's domain goes live without a deploy, once DNS and the certificate are ready.
  `HELP_CUSTOM_DOMAINS` is removed when #427 lands, and its domains are moved into
  `mocco_domains` as verified rows.
- A new or removed domain can take up to a minute to take effect on instances that cached
  the old answer. Certificate issuance already takes longer than that.
- Every public-site request now passes through the proxy, which costs a memory read on a
  warm instance and one query per host per minute per instance otherwise. If that shows up in
  latency metrics, decision 2 is where Edge Config goes.
- Routing is the same on Vercel and when self-hosted. Only the provisioner driver differs.
- The `vercel` driver needs a Vercel API token that can manage the production project's
  domains, set only in the production environment.
