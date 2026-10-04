---
title: Status page model
description: How Mocco stores a project's status pages, component groups and components, how tenancy is enforced, what is audited, and the status tRPC router. Incidents and scheduled maintenance join in the next slice.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, status, components]
related:
  - ../specs/2026-09-24-status-page-design.md
  - ../adr/0027-status-probes-are-pull-based-agents.md
  - ../adr/0028-status-pages-are-static-snapshots.md
  - ./project.md
code_refs:
  - packages/common/src/status.ts
  - packages/backend/src/domain/status/StatusPageService.ts
  - packages/backend/src/transport/trpc/routers/status.ts
---

# Status page model

The status page product ([design spec](../specs/2026-09-24-status-page-design.md), issue #103) lands in slices.
This page describes what is built: operators manage a project's status pages, component groups and components
by hand through the `status.*` tRPC router. The next slice of #148 adds incidents, scheduled maintenance, the
status a component shows (derived from both) and the maintenance tick. There is no operator UI, public page,
monitor, subscriber or deploy correlation yet.

## Tables

Every table is `mocco_status_*`, carries `workspace_id`, and belongs to a project
([ADR 0013](../adr/0013-mocco-is-a-multi-product-platform.md)).

| Table | Holds |
|---|---|
| `mocco_status_pages` | A page: `slug` and `title`. The slug is unique across all workspaces, because it becomes the public host label; it follows the project handle pattern (lowercase letters, digits and inner hyphens, 1 to 40 characters), checked in zod and in the DB |
| `mocco_status_component_groups` | A heading on a page ("API", "Dashboard"), with `position` |
| `mocco_status_components` | A part of the service a page reports on: `name`, `description`, optional `group_id`, `position`, and `status`, the one an operator sets by hand (`operational`, `maintenance`, `degraded`, `partial_outage`, `major_outage`) |

Pages reference `mocco_projects(id, workspace_id)`. Groups and components reference
`mocco_status_pages(id, workspace_id, project_id)` through composite foreign keys, so no row can point at
another tenant's page, even through a direct insert. A component's group is referenced by `(group_id, page_id)`,
so a component can only be in a group on its own page. Deleting a page deletes its groups and components;
deleting a group ungroups its components first. New groups and components go after the last one unless a
`position` is given.

The component statuses are `ComponentStatuses` in `@mocco/common/status`, and the DB check is generated from it.

## Audit

Creating and deleting a page (`status.page.created`, `status.page.deleted`, subject `status_page`) and setting a
component's status by hand (`status.component.status_changed` with `from` and `to`, subject `status_component`)
are appended to the workspace's audit chain. Group and other component edits are not audited.

## tRPC

`status.*` is built on `productProcedure(Products.status)`: the caller must be a member of `workspaceId`,
`projectId` must belong to it, and the status product must be enabled (`FORBIDDEN` otherwise). The same
procedure maps the domain's errors: `StatusEntityNotFoundError` is `NOT_FOUND`, `StatusPageSlugTakenError` is
`CONFLICT`. Every lookup is scoped by workspace and project, so another tenant's ids are `NOT_FOUND`. A test calls
every procedure as a non-member and with another tenant's ids, and fails if a procedure is missing from it.

| Procedures | Purpose |
|---|---|
| `pages`, `page`, `createPage`, `updatePage`, `deletePage` | Pages; `page` returns the page with its groups and components in order |
| `createGroup`, `updateGroup`, `deleteGroup` | Groups |
| `createComponent`, `updateComponent`, `setComponentStatus`, `deleteComponent` | Components; `setComponentStatus` is audited |

MCP tools ([ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)) follow once incidents exist:
`mocco_status_incidents_search` and `mocco_status_incidents_get` first, then a mutating tool for posting an
incident update behind the workspace's switch.

## Not built yet

Incidents, their timeline and affected components, scheduled maintenance and the `status.maintenance.tick` job
come in the next slice. Monitors and `status_source`, the public snapshot (`visibility`, `locale`, `theme`,
`dirty_at`, `published_*`), custom domains, subscribers, repo and project links on components, and run links
arrive with their own slices. Each is an additive column or table.
