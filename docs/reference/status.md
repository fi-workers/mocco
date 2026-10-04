---
title: Status page model
description: How Mocco stores a project's status pages — pages, component groups, components, incidents with their timeline and affected components, and scheduled maintenance — the incident lifecycle, how a component's shown status is derived, the maintenance tick, what is audited, and the status tRPC router.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, status, components, incidents, maintenance]
related:
  - ../specs/2026-09-24-status-page-design.md
  - ../adr/0027-status-probes-are-pull-based-agents.md
  - ../adr/0028-status-pages-are-static-snapshots.md
  - ./project.md
  - ./jobs.md
code_refs:
  - packages/common/src/status.ts
  - packages/backend/src/domain/status/StatusPageService.ts
  - packages/backend/src/domain/status/IncidentService.ts
  - packages/backend/src/domain/status/MaintenanceService.ts
  - packages/backend/src/domain/status/ComponentStatusService.ts
  - packages/backend/src/domain/status/component-status.ts
  - packages/backend/src/domain/status/jobs.ts
  - packages/backend/src/transport/trpc/routers/status.ts
  - packages/frontend/src/components/status/status-pages.tsx
  - packages/frontend/src/components/status/page-components.tsx
  - packages/frontend/src/components/status/incidents.tsx
  - packages/frontend/src/components/status/incident-detail.tsx
  - packages/frontend/src/components/status/maintenance.tsx
---

# Status page model

The status page product ([design spec](../specs/2026-09-24-status-page-design.md), issue #103) lands in slices.
This page describes what is built (#148): operators manage a project's status pages, components, incidents and
scheduled maintenance by hand through the `status.*` tRPC router. There is no public page, monitor, subscriber or
deploy correlation yet.

## Console

A project's **Status page** section (`/workspaces/[id]/p/[projectId]/status`, shown when the status product is on)
lists the project's pages as tabs; `?page=` selects the one shown. With no page yet, it opens on a form to create
one: a title, and an address (the slug) suggested from the title. On a page, an operator adds component groups and
components (name, optional description, optional group), renames, regroups and deletes them, and moves groups and
components up and down (the screen rewrites `position` for the rows whose place changes). Each component shows the
status the page shows (`displayedStatus`) next to a select for the status reported by hand; when an open incident
or maintenance makes it show worse, the row says so. Page settings rename the page, change its address (a taken
address is refused with the domain error) and delete it with everything on it.

Each page has three views, chosen with `?tab=`: components (the default), incidents and maintenance. The incidents
view lists the open or resolved incidents (`?filter=open|resolved`; resolved is the full list filtered on the
client) and declares an incident with its title, severity, opening status, first update and affected components
with impact. An incident's own route (`/status/incidents/[incidentId]`) posts updates whose status select offers
only the current status and `INCIDENT_TRANSITIONS` from it; an update refused by the service (the incident moved
on in another tab) shows the `IncidentTransitionError` text and reloads the incident. It also shows the timeline
(newest first), replaces the affected components, and sets or clears the postmortem. The maintenance view groups
windows into in progress, scheduled and past, schedules a window (`datetime-local` inputs in the viewer's time
zone, with the components it covers), and cancels a scheduled or in-progress one. The customer guide is
[Run a status page](../customer/status/status-page.md).

## Tables

Every table is `mocco_status_*`, carries `workspace_id`, and belongs to a project through its page
([ADR 0013](../adr/0013-mocco-is-a-multi-product-platform.md)).

| Table | Holds |
|---|---|
| `mocco_status_pages` | A page: `slug` and `title`. The slug is unique across all workspaces, because it becomes the public host label; it follows the project handle pattern (lowercase letters, digits and inner hyphens, 1 to 40 characters), checked in zod and in the DB |
| `mocco_status_component_groups` | A heading on a page ("API", "Dashboard"), with `position` |
| `mocco_status_components` | A part of the service: `name`, `description`, optional `group_id`, `position`, and `status`, the one an operator sets by hand |
| `mocco_status_incidents` | `title`, `status`, `severity` (`minor`, `major`, `critical`), `started_at`, `identified_at`, `resolved_at`, `postmortem_md`, `created_by_user_id` |
| `mocco_status_incident_updates` | The incident's timeline: `status` and `body_md` per update, append-only |
| `mocco_status_incident_components` | The components an incident affects, with `impact` (`degraded`, `partial_outage`, `major_outage`) |
| `mocco_status_maintenances` | A window: `title`, `body_md`, `scheduled_start`/`scheduled_end` (end after start, DB-checked), `status`, `actual_start`/`actual_end` |
| `mocco_status_maintenance_components` | The components a window covers |

Pages reference `mocco_projects(id, workspace_id)`. Groups, components, incidents and maintenance windows
reference `mocco_status_pages(id, workspace_id, project_id)` through composite foreign keys, so no row can point at
another tenant's page, even through a direct insert. A component's group is referenced by `(group_id, page_id)`, so
a component can only be in a group on its own page. Incident and maintenance links reference
`(component_id, workspace_id)` and `(incident_id, workspace_id)` / `(maintenance_id, workspace_id)`; the services
also require every linked component to be on the incident's or window's page. Deleting a page deletes everything
on it; deleting a group ungroups its components first.

Every status set is an `as const` object in `@mocco/common/status`, and the DB checks are generated from it.

## Incidents

An incident belongs to a page and is opened with its first update, in `investigating`, `identified` or
`monitoring` (never `resolved`). Each later update may change the status:

| From | May move to |
|---|---|
| `investigating` | `identified`, `monitoring`, `resolved` |
| `identified` | `monitoring`, `resolved` |
| `monitoring` | `identified` (the fix didn't hold), `resolved` |
| `resolved` | nothing: a resolved incident is closed |

Moving forward may skip steps. An update that keeps the status is allowed while the incident is open. Anything
else throws `IncidentTransitionError` (a `ConflictError`, so `CONFLICT` over tRPC) and changes nothing. The update
locks the incident row, so two concurrent updates can't both pass the check.

`resolved_at` is set if and only if the status is `resolved`; a DB check enforces it as well. `identified_at` is
set the first time the incident reaches `identified` and is kept after that.

The affected components can be replaced at any time. The postmortem is a Markdown field that can be set or cleared.

## What a component shows

A component's `status` is what an operator reported. The status the page shows is derived
(`deriveComponentStatus`): the worst of that status, the impacts of the unresolved incidents affecting the
component, and `maintenance` while a window covering it is in progress. The order is
`operational` < `maintenance` < `degraded` < `partial_outage` < `major_outage`, so an outage during a maintenance
window still shows as an outage. `status.page` returns each component with `displayedStatus`. Monitors join the
derivation in their own slice.

## Maintenance

A window is scheduled with its components and starts as `scheduled`. The `status.maintenance.tick` job runs every
minute as a platform schedule ([jobs](./jobs.md)) and calls `MaintenanceService.tick(now)`:

1. Every `scheduled` or `in_progress` window whose end has passed becomes `completed`. A window the tick never saw
   start goes straight to `completed`.
2. Every `scheduled` window whose start has passed becomes `in_progress`.

Each step is one conditional `UPDATE`, so overlapping ticks can't move a window twice. `actual_start` and
`actual_end` record when the tick made the change. An operator can cancel a `scheduled` or `in_progress` window
(one in progress ends now). A completed or canceled window can't be canceled (`MaintenanceTransitionError`,
`CONFLICT`). Windows can't be edited yet: cancel the window and schedule a new one. The spec's `overrun` status
belongs to run-linked windows and arrives with them.

## Audit

These changes are appended to the workspace's audit chain, after their transaction commits:

| Action | Subject |
|---|---|
| `status.page.created`, `status.page.deleted` | `status_page` |
| `status.component.status_changed` (from, to) | `status_component` |
| `status.incident.created`, `status.incident.updated` (from, to), `status.incident.components_changed`, `status.incident.postmortem_changed` | `status_incident` |
| `status.maintenance.scheduled`, `status.maintenance.canceled` | `status_maintenance` |
| `status.maintenance.started`, `status.maintenance.completed` (by the tick, no actor) | `status_maintenance` |

Group and other component edits are not audited.

## tRPC

`status.*` is built on `productProcedure(Products.status)`: the caller must be a member of `workspaceId`,
`projectId` must belong to it, and the status product must be enabled (`FORBIDDEN` otherwise). The same procedure
maps the domain's errors: `StatusEntityNotFoundError` is `NOT_FOUND`; `StatusPageSlugTakenError`,
`IncidentTransitionError` and `MaintenanceTransitionError` are `CONFLICT`; `MaintenanceWindowError` is
`BAD_REQUEST`. Every lookup is scoped by workspace and project, so another tenant's ids are `NOT_FOUND`. A test
calls every procedure as a non-member and with another tenant's ids, and fails if a procedure is missing from it.

| Procedures | Purpose |
|---|---|
| `pages`, `page`, `createPage`, `updatePage`, `deletePage` | Pages; `page` returns groups and components with `displayedStatus` |
| `createGroup`, `updateGroup`, `deleteGroup` | Groups |
| `createComponent`, `updateComponent`, `setComponentStatus`, `deleteComponent` | Components; `setComponentStatus` is audited |
| `incidents`, `incident`, `createIncident`, `postIncidentUpdate`, `setIncidentComponents`, `setPostmortem` | Incidents; `incident` returns the timeline and affected components |
| `maintenances`, `scheduleMaintenance`, `cancelMaintenance` | Maintenance |

MCP tools ([ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)) come in the next slice:
`mocco_status_incidents_search` and `mocco_status_incidents_get` to read, then a mutating tool for posting an
incident update behind the workspace's switch.

## Not built yet

Monitors and `status_source`; the public snapshot (`visibility`, `locale`, `theme`, `dirty_at`, `published_*`);
custom domains; subscribers; incident `visibility` and `origin`; repo and project links on components; run links
(`suspected_run_id`, `mocco_status_incident_runs`); and gate-linked maintenance (`run_id`, `gate_id`, `overrun`,
`suppress_alerts`). Each arrives with its slice as an additive column or table.
