---
title: Position Mocco around the production record, with products grouped by job
description: Mocco is presented as one workspace to release, control and support an app, built on one record of what reached production and who approved it; "write ≠ ship" generalizes "write ≠ deploy", and the landing page and app navigation group products by job (Release, Support, Operate).
type: adr
status: superseded
superseded_by: ./0027-mocco-is-everything-a-product-needs-except-the-code.md
created: 2026-10-04
updated: 2026-10-04
confidence: medium
owner: andrea
decision_date: 2026-10-04
stakeholders: [andrea]
tags: [adr, product, positioning, navigation, landing]
related:
  - ./0002-mocco-is-an-independent-authorization-layer.md
  - ./0013-mocco-is-a-multi-product-platform.md
  - ./0020-approvals-outside-pipeline-runs.md
  - ./0025-every-product-surface-ships-mcp-tools.md
  - ../reference/roadmap.md
---

# ADR 0026 — Position Mocco around the production record, with products grouped by job

## Context

Until October 2026 Mocco described itself two ways at once. The landing page said "a deploy
governance control plane on top of GitHub Actions". The README and `AGENTS.md` said "an
all-in-one SaaS for developers" whose further products were planned. Neither matched what had
shipped: deploy governance, OTA updates and force update, feature flags, a customer messenger,
a help center and notification relay, plus a public API, SDKs, a CLI and an MCP server.

The roadmap also ran in a different order than planned. The status page, app reviews and the
feedback board (waves 2 and 3) have not started, while the messenger and the help center (wave 4)
have shipped, along with MCP and the CLI, which no wave named.

Two problems followed:

- **The product undersold itself in public.** A visitor saw one product out of five.
- **The console listed screens instead of jobs.** The workspace sidebar was eight flat items, and its
  first item, "Overview", was really deploy governance's repository list. A project with every product
  on had eight tabs, three of them for OTA.

Researching other multi-product developer platforms (Vercel, Supabase, PostHog, Sentry, Expo,
LaunchDarkly, Statsig, Firebase) showed a consistent pattern:

- the landing page groups products by lifecycle stage and gives the suite one framing claim;
- the console has separate organization and project contexts;
- the sidebar groups sections by job, not by data model.

## Decision

1. **One position.** Mocco is one workspace to release, control and support an app. Its claim is
   *"Ship fast. Know what shipped."*: every production change (a deploy, an OTA release, a raised
   minimum app version, a protected flag change) goes through the same approvals and the same audit
   log. Mocco is the record of what reached production, when, and who approved it. That record is the
   advantage every product builds on ([roadmap](../reference/roadmap.md#the-advantage-every-product-builds-on)).
2. **"Write ≠ ship" generalizes "write ≠ deploy".** Being able to push or generate code never grants
   the right to change production, for any product. The direction rule from the roadmap is part of the
   principle: changes that add risk wait for a role, and changes that remove risk (rollback, kill
   switch) apply at once and are recorded. With ADR 0025, the same principle covers agents: they read,
   and a person approves.
3. **Products are grouped by job.** The groups are *Release* (deploy governance, OTA and force update,
   feature flags, later deep links), *Support* (messenger, help center, later feedback and forum),
   *Operate* (notifications, audit, later status page and app reviews) and *Platform* (end-user
   identity), plus *Developers* (API keys) and *Workspace* (members, access, products, settings) in the
   console. The group of every section and product lives in the frontend product registry
   (`SectionGroups` in `lib/products.ts`), so the landing page, the Products page and both sidebars
   read one source.
4. **The console has two contexts.** The workspace sidebar holds workspace-wide sections, and a
   workspace opens on **Home**: approvals waiting in every product, recent audit entries and the
   projects. Entering a project swaps the sidebar for the project's own grouped sections, with a way
   back. A product with several screens gets one sidebar entry and tabs inside it (OTA updates: Hosted
   by Mocco / Your OTA tool).
5. **The landing page shows only what ships.** Shipped products appear in their group with a link to
   their guide. The products still to come are one line read from the registry, so a product that ships
   never stays listed as coming. The page makes no claim that a guide or ADR doesn't back, and it
   shows no invented customers or metrics.

## Alternatives considered

- **Keep "all-in-one platform for developers" as the headline.** Rejected: it names a category, not a
  reason to choose Mocco, and it reads as a list of eleven products of which six don't exist yet.
- **Keep deploy governance as the headline and list the rest below.** Rejected: it hides four shipped
  products, and teams that come for OTA or flags never see themselves in it.
- **One landing section per product.** Rejected: the research showed the strongest pages make one
  system claim and group products under it. A section per product scales badly to eleven.
- **Keep one sidebar and add more tabs per project.** Rejected: the tabs already overflowed, which is
  the reason Vercel replaced its project tabs with a sidebar.

## Consequences

- The README, `AGENTS.md` and the wiki index describe Mocco by this position, and the roadmap records
  the order products actually shipped in.
- Each new product picks its group in the registry when its screens land. No layout code changes.
- Home links each pending approval to the screen where it is decided. Approval requests carry no
  project, so for now Home traces their subjects through the projects' own lists. If that grows
  costly, the fix is a project reference on the approval request (a schema change with its own
  migration), not more client composition.
- The customer guides name sidebar pages, not tabs. Screenshots taken before the new navigation show
  the old tabs until they are retaken.
