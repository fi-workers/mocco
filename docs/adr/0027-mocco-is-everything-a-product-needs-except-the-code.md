---
title: Mocco is everything a product needs, except the code
description: Supersedes ADR 0026's position. Mocco is presented as everything it takes to build and run a service besides the code — release, operations and support as equal parts sharing one team, one set of roles and one history; "write ≠ ship" is the Release principle, not the whole concept. ADR 0026's grouping and navigation decisions carry over.
type: adr
status: draft
created: 2026-10-04
updated: 2026-10-04
confidence: high
owner: andrea
decision_date: 2026-10-04
stakeholders: [andrea]
supersedes: ./0026-position-mocco-around-the-production-record.md
tags: [adr, product, positioning, navigation, landing]
related:
  - ./0013-mocco-is-a-multi-product-platform.md
  - ./0020-approvals-outside-pipeline-runs.md
  - ./0025-every-product-surface-ships-mcp-tools.md
  - ./0026-position-mocco-around-the-production-record.md
  - ../reference/roadmap.md
---

# ADR 0027 — Mocco is everything a product needs, except the code

## Context

[ADR 0026](./0026-position-mocco-around-the-production-record.md) positioned Mocco around one record of what
reached production. Its headline was "Ship fast. Know what shipped.", and its principle "write ≠ ship"
framed every product as a kind of release.

That reads Mocco through deploy governance, its first product, again. Release is one part of what Mocco
does. The messenger and the help center (shipped), and the forum, the feedback board and app reviews
(planned), are about talking to the people who use the product. Notifications and the status page are
about running it. Describing the messenger as "answering your users from the same place you ship" makes it
an appendix of the release story, and a team that comes for the help center doesn't see itself in it.

The scope the product owner set is everything it takes to **build and run a service** (서비스를 만들고
관리하는 그 모든 것), apart from writing the code.

## Decision

1. **The position.** Mocco is *everything your product needs, except the code*. You ship it, run it and
   hear from the people who use it, in one workspace. The subject is the product or service a team runs,
   whether that's an app, a web service or an API, not only a mobile app.
2. **Three equal parts.** *Release* (deploy governance, OTA and force update, feature flags, later deep
   links), *Operate* (notifications, audit, later status page and app reviews) and *Support* (messenger,
   help center, later feedback board and forum). No part frames the others.
3. **What sets it apart is the shared context.** Every product starts from the same team, the same roles,
   the same audit log and, with end-user identity, the same users. Separate tools each keep their own.
   The record of what reached production is one consequence of that shared context, not the concept.
4. **"Write ≠ ship" is the Release principle.** Changes that add risk wait for a role, changes that remove
   risk apply at once and are recorded, and agents read while people approve (ADR 0025). That stays true
   and stays prominent in the Release part. It is not the headline.
5. **ADR 0026's other decisions carry over unchanged:** grouping by job from the product registry
   (`SectionGroups`), the workspace and project contexts in the console, Home, one sidebar entry per
   product with tabs inside it, and a landing page that shows only what ships.

## Alternatives considered

- **Keep the production record as the concept (ADR 0026).** Rejected: it subordinates support and
  operations to releases, which is the same narrowing ADR 0013 moved away from.
- **"Ship it. Run it. Support it." as the headline.** Close. It names the three parts but not the scope
  ("everything except the code"), which is what tells a team it can drop its other tools.
- **"Every tool knows the others" as the headline.** Rejected for now: the strongest examples of it (the
  inbox knowing a user's release, alerts naming the change behind them) aren't built yet, and the landing
  only claims what ships.

## Consequences

- The landing page leads with "Everything your product needs, except the code." Its example is a feed
  that mixes release, operations and support, and a section explains the shared context ("One workspace,
  not ten tools"). "Write ≠ ship" moves into the Release group's summary.
- The README, `AGENTS.md` and the wiki index describe Mocco this way, and ADR 0026 is marked superseded.
- New products are written up by the job they do for the service, not by how they relate to releases.
