---
title: Project model and product enablement
description: Projects below workspaces (apps, linked repos), per-workspace product enablement, the DB-enforced tenancy invariants, and the tRPC procedures product routers build on.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, project, product, schema, tenancy]
related:
  - ../adr/0013-mocco-is-a-multi-product-platform.md
  - ./workspace.md
  - ./roadmap.md
code_refs:
  - packages/common/src/project.ts
  - packages/backend/src/domain/project/ProjectService.ts
  - packages/backend/src/domain/project/ProductEnablementService.ts
  - packages/backend/src/transport/trpc/project-procedures.ts
  - packages/backend/src/transport/trpc/routers/project.ts
  - packages/backend/src/transport/trpc/routers/product.ts
---

# Project model and product enablement

> The workspace is the team and billing boundary. A **project** is a product the team ships; every product line after deploy governance scopes its data to one. Decision: [ADR 0013](../adr/0013-mocco-is-a-multi-product-platform.md).

## Tables

| Table | Key | Notes |
|---|---|---|
| `mocco_projects` | `id`; unique `(workspace_id, handle)`; unique `(id, workspace_id)` | `handle` matches `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` (DB check). `default_locale` defaults to `en`. `archived_at` set = archived. |
| `mocco_project_apps` | `id`; partial unique `(project_id, platform, bundle_id)` where `bundle_id` is set | `platform` ∈ `AppPlatforms` (DB check). Optional `bundle_id`, `store_app_id`, `web_origins`. |
| `mocco_project_repos` | PK `(project_id, repo_id)`; index `repo_id` | A repo may be linked to several projects. |
| `mocco_workspace_products` | PK `(workspace_id, product)` | `product` ∈ `Products` minus `governance` (DB check generated from the constant). |

## Invariants

- **No cross-workspace children.** Apps and repo links carry `workspace_id` and reference `mocco_projects(id, workspace_id)` (and, for links, `mocco_repos(id, workspace_id)`) through composite foreign keys. A direct insert that mixes workspaces fails in the DB.
- **Governance is always on.** `governance` is never stored; `isEnabled(…, governance)` is `true`, `disable(governance)` is rejected, `enable(governance)` is a no-op. `list` returns governance first.
- **Idempotent writes.** Enabling or disabling a product twice, archiving an archived project, and linking a linked repo are no-ops that return the current state.
- **Archived projects are read-only.** Reads and unarchiving work; update, adding/removing apps and linking/unlinking repos return `ProjectArchivedError` (`BAD_REQUEST`).

## Errors

| Domain error | Base | tRPC code |
|---|---|---|
| `ProjectNotFoundError`, `ProjectAppNotFoundError`, `ProjectRepoNotFoundError` | `NotFoundError` | `NOT_FOUND` |
| `ProjectHandleTakenError`, `ProjectAppBundleTakenError` | `ConflictError` | `CONFLICT` |
| `ProjectArchivedError`, `ProductAlwaysEnabledError` | `BadRequestError` | `BAD_REQUEST` |
| `ProductNotEnabledError` | `ForbiddenError` | `FORBIDDEN` |

Unique violations reach the service as the DB-layer `UniqueConstraintError` (`infra/db/errors.ts`, thrown by the repo with the constraint name); the service maps the constraints it owns and lets anything else propagate.

## tRPC surface

- `project.create | list | get | update | setArchived | addApp | listApps | removeApp | linkRepo | unlinkRepo | listRepos` — every procedure takes `workspaceId`; project procedures also take `projectId`.
- `product.list | enable | disable` — workspace-level.

### Procedures for product routers

`transport/trpc/project-procedures.ts`:

- `protectedWorkspaceProcedure` — the caller is a member of `workspaceId` (non-member → `NOT_FOUND`).
- `protectedProjectProcedure` — also `projectId` belongs to `workspaceId` (foreign/unknown → `NOT_FOUND`), checked before the resolver runs.
- `productProcedure(Products.x)` — also the product is enabled in the workspace (`FORBIDDEN` otherwise).

These map the project domain's errors. A product router composes them and maps its own domain's errors in its own router-scoped middleware.

## Known gaps

- Product enablement is open to any member; owner/admin restriction lands with billing.
- No UI yet (the multi-product app shell is a separate slice).
- `mocco_releases` (version ↔ run) lands with the domain-events slice.
