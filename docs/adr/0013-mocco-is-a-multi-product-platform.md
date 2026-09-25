---
title: Mocco is a multi-product platform — projects below workspaces, per-workspace product enablement
description: Mocco hosts many product lines. A project (a product the team ships, with apps and linked repos) sits below the workspace and scopes every product after deploy governance; which products are on is recorded per workspace, with deploy governance always on.
type: adr
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
decision_date: 2026-09-25
stakeholders: [andrea]
tags: [adr, platform, project, product, tenancy]
related:
  - ../reference/project.md
  - ../reference/roadmap.md
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ./0012-repository-per-table-for-db-owning-domains.md
---

# ADR 0013 — Mocco is a multi-product platform

## Context

Mocco is an all-in-one platform for developers ([roadmap](../reference/roadmap.md)). Deploy governance is the first product line; ten more follow (OTA, feature flags, status page, reviews, feedback, messenger, help center, forum, deep links, end-user identity). Until now the only tenant scope was the **workspace**, and every table hung directly off it.

That is not enough for the next products. A team ships several products from one workspace ("Acme mobile", "Acme admin"), each with several build targets (iOS bundle id, Android package, web origins) and several repos. OTA channels, flag rulesets, status pages, review sources and help centers all belong to one of those products, not to the team as a whole. Without a shared entity, each product would invent its own "app" table and its own way to relate it to repos and releases.

The team also needs to turn products on one by one. Billing lives at the workspace, so that is where enablement belongs.

## Decision

1. **A project sits below the workspace.** `mocco_projects` is "a product the team ships": a name, a url-safe `handle` unique per workspace, a default locale, and `archived_at` for soft archiving. Every product line after deploy governance scopes its data to a project.
2. **A project has apps and linked repos.** `mocco_project_apps` holds one row per build target (`platform` in a fixed set; optional bundle id, store id, web origins). `mocco_project_repos` links repos to projects; a repo may belong to several projects (a monorepo).
3. **Tenancy is enforced in the database.** Child tables carry `workspace_id` and reference `(id, workspace_id)` through composite foreign keys, so a project can never hold an app or link a repo from another workspace, even through a direct insert. Every repo query is also workspace-scoped (ADR 0012).
4. **Governance is unchanged.** Runs, gates, credentials and audit stay workspace-scoped. They relate to projects only through `mocco_project_repos` (a run knows its repo), so nothing in the governance domain moves.
5. **Products are enabled per workspace.** `mocco_workspace_products` stores one row per enabled product. The product set is one constant, `Products` in `@mocco/common/project`, and the DB check is generated from it. Deploy governance is implicitly on (no row, cannot be disabled) so every existing workspace keeps working.
6. **Product routers compose shared procedures.** `transport/trpc/project-procedures.ts` provides `protectedWorkspaceProcedure`, `protectedProjectProcedure` (member of the workspace AND the project belongs to it) and `productProcedure(product)` (also requires the product enabled; `FORBIDDEN` otherwise). A product router builds on these instead of re-implementing tenant checks.

## Alternatives considered

- **Keep everything workspace-scoped and add a per-product "app" table in each product.** Rejected: ten parallel app models, no shared place for bundle ids or repo links, and no way for reviews, OTA and deep links to agree on "which app".
- **Make the project the tenant boundary (move members and billing down).** Rejected: teams share people and billing across their products; the workspace is already the member, role and billing boundary, and moving it would rewrite governance.
- **Enable products per project.** Rejected for enablement (billing is per workspace), but each product still decides per project whether it has any configuration (e.g. a status page exists for project X).

## Consequences

- Every new product's tables get `workspace_id` + `project_id` with a composite FK to `mocco_projects(id, workspace_id)`, and its router starts from `productProcedure(Products.<product>)`.
- `mocco_repos` gains a unique constraint on `(id, workspace_id)` so links can reference it.
- Unique-constraint violations become domain errors through the DB-layer `UniqueConstraintError` (the repo names the constraint, the service maps it), mirroring `EntityNotFoundError`. `ConflictError` joins the shared error bases and maps to `CONFLICT`.
- Enabling and disabling products is open to any workspace member for now. Restricting it to owners/admins lands with billing.
- The release registry (`mocco_releases`), the product-aware app shell and product navigation are separate slices of the platform foundations epic (#106).
