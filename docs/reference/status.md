---
title: Status page model
description: How Mocco stores a project's status pages — pages, component groups, components, incidents with their timeline and affected components, and scheduled maintenance — the incident lifecycle, how a component's shown status is derived, the maintenance tick, how the public page is published as static snapshots (and served by self-hosters), monitors and probe locations, what is audited, and the status tRPC router.
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
  - packages/backend/src/domain/status/MonitorService.ts
  - packages/backend/src/domain/status/LocationService.ts
  - packages/backend/src/domain/status/ComponentStatusService.ts
  - packages/backend/src/domain/status/component-status.ts
  - packages/backend/src/domain/status/jobs.ts
  - packages/backend/src/domain/status/SnapshotService.ts
  - packages/backend/src/domain/status/SnapshotScheduler.ts
  - packages/backend/src/domain/status/StaticPublisher.ts
  - packages/backend/src/domain/status/snapshot/format.ts
  - packages/backend/src/domain/status/snapshot/project.ts
  - packages/backend/src/domain/status/snapshot/render.ts
  - packages/backend/src/transport/trpc/routers/status.ts
  - packages/frontend/src/components/status/status-pages.tsx
  - packages/frontend/src/components/status/page-components.tsx
  - packages/frontend/src/components/status/incidents.tsx
  - packages/frontend/src/components/status/incident-detail.tsx
  - packages/frontend/src/components/status/maintenance.tsx
---

# Status page model

The status page product ([design spec](../specs/2026-09-24-status-page-design.md), issue #103) lands in slices.
This page describes what is built: operators manage a project's status pages, components, incidents and scheduled
maintenance by hand through the `status.*` tRPC router (#148), and every change is published as a static public page
(#149, [below](#public-page)). Monitors and probe locations can be configured (#150, [below](#monitors-and-the-probe-protocol)),
but nothing checks them yet. There is no subscriber or deploy correlation yet.

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
| `mocco_status_pages` | A page: `slug` and `title`. The slug is unique across all workspaces, because it becomes the public host label; it follows the project handle pattern (lowercase letters, digits and inner hyphens, 1 to 40 characters), checked in zod and in the DB. `dirty_at` (a change is waiting to be published), `published_version` and `published_at` track the [public page](#public-page) |
| `mocco_status_component_groups` | A heading on a page ("API", "Dashboard"), with `position` |
| `mocco_status_components` | A part of the service: `name`, `description`, optional `group_id`, `position`, and `status`, the one an operator sets by hand |
| `mocco_status_incidents` | `title`, `status`, `severity` (`minor`, `major`, `critical`), `visibility` (`published`, or `draft`, which never reaches the public page), `started_at`, `identified_at`, `resolved_at`, `postmortem_md`, `created_by_user_id` |
| `mocco_status_incident_updates` | The incident's timeline: `status` and `body_md` per update, append-only |
| `mocco_status_incident_components` | The components an incident affects, with `impact` (`degraded`, `partial_outage`, `major_outage`) |
| `mocco_status_maintenances` | A window: `title`, `body_md`, `scheduled_start`/`scheduled_end` (end after start, DB-checked), `status`, `actual_start`/`actual_end` |
| `mocco_status_maintenance_components` | The components a window covers |
| `mocco_status_page_snapshots` | A published version of the public page: `version` (per page, from 1), `etag`, the snapshot `body` (jsonb), `built_at`, `uploaded_at` and `upload_error`. The last 20 versions are kept |
| `mocco_status_locations` | Where probes run: `code`, `name`, `kind` (`hosted`, `private`, `embedded`), `token_hash`, `last_seen_at`, `agent_version`, `disabled_at`. `workspace_id` is set for a private location and null otherwise (DB-checked) |
| `mocco_status_monitors` | A check of a project: `name`, `kind` (`http`, `tcp`), `spec` (jsonb), `interval_s` (60 or more, DB-checked), `confirmations`, `recovery_confirmations`, `quorum_mode`, `state`, `state_changed_at`, `next_round_at` |
| `mocco_status_monitor_locations` | The locations a monitor runs at |
| `mocco_status_component_monitors` | The components a monitor reports on, with `impact_when_down` |
| `mocco_status_monitor_state_changes` | Every change of a monitor's state: `from_state`, `to_state`, `at`, `round_at`, `reason`. Append-only, and the source of truth for downtime |

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

## Public page

Each page is published as static files on object storage ([ADR 0028](../adr/0028-status-pages-are-static-snapshots.md)),
so reading it never touches the Mocco app or database.

**Publishing.** Every change that affects the page (a page, group or component edit, a manual status, an incident or
its update or affected components, a maintenance window scheduled, canceled, started or completed) sets the page's
`dirty_at` in the change's own transaction (`SnapshotScheduler.change`). After the commit it enqueues the
`status.snapshot.publish` job for the page, deduplicated per page and kicked at once. The job
(`SnapshotService.publish`) builds a version, stores it in `mocco_status_page_snapshots`, clears `dirty_at` unless the
page changed again meanwhile, and uploads it. Requests that arrive while the page's job is queued or running join that
job, and a page that changed during the build is built again in the same run (up to three times), so a burst of edits
produces one or two versions. The same job without a page runs every five minutes as a safety net: it requests a
publish for every page that is dirty, was never published, or whose newest version failed to upload. An upload
failure is stored in `upload_error` and doesn't fail the job; the safety run retries it. Without an object store
(`STORAGE_DRIVER` unset on Vercel) pages are only marked dirty and the job does nothing.

**The snapshot** (`snapshot/format.ts`) is an allowlist projection (`snapshot/project.ts`): the page title and slug,
the overall status, the components by group with the status they show, open incidents with their updates, maintenance
in progress or scheduled, and the latest 50 resolved incidents. Only `published` incidents are read, and a draft's
impact doesn't count toward a component's public status. Component ids are the only internal ids; an incident is keyed
by a hash of its id, and no author or user appears. Postmortems are not published yet. The 90-day uptime bars show
"no data" until daily rollups exist.

**Files**, through the storage domain's `ObjectStore` under `pub/status/{slug}/` (`StaticPublisher`):

| File | Cache-Control | Written |
|---|---|---|
| `v/{version}/snapshot.json`, `v/{version}/index.html`, `v/{version}/feed.atom` | `public, max-age=31536000, immutable` | First |
| `index.html`, `feed.atom` (the current version's page and feed) | `public, max-age=15, stale-while-revalidate=60, stale-if-error=604800` | Second |
| `current.json` (`{ version, etag, builtAt }`) | Same as above | Last |

The page is plain HTML and CSS rendered by the backend (`snapshot/render.ts`, every customer string escaped) and shows
the current state without JavaScript. Its script shows times in the visitor's time zone and, while the tab is visible,
polls `current.json` every 30 seconds; when the version changes it fetches `v/{version}/index.html` and swaps the
page's content in place. The Atom feed has one entry per incident update. When versions beyond the last 20 are pruned
their files are deleted too. Not built yet: purging the CDN's copy of the pointer, removing a deleted page's files,
and moving the files when a page's slug changes (the old address keeps the last version).

### Serving it yourself

With the `filesystem` storage driver, the public directory is `$STORAGE_FS_ROOT/pub/status` (by default
`.mocco-storage/pub/status` in the app's working directory). Each page is a folder named by its slug. Point any static
web server or CDN at that directory, for example:

```bash
python3 -m http.server 8080 --directory "$STORAGE_FS_ROOT/pub/status"   # http://localhost:8080/<slug>/
npx http-server "$STORAGE_FS_ROOT/pub/status" -p 8080
```

or an nginx `root`, or a bucket sync. The server only needs to serve files; it never calls Mocco. The driver writes
each file to a temporary name and renames it into place, so a reader never gets half a file. A plain static server
sends its own cache headers; to honor the table above, configure them on the server or CDN (the intended values are
also stored in each file's `.meta.json` sidecar, which a server should not expose).

**When the app is down**, the directory keeps serving the last published version: visitors see the page as of
`Updated …` at its foot, and the script keeps polling `current.json` and simply finds no new version. Nothing is
published until the app (and its job tick) runs again; on start the next tick's safety run publishes every page that
changed in the meantime. Posting an incident while the app is down needs the break-glass path, which isn't built yet.

## Monitors and the probe protocol

A monitor is an HTTP or TCP check of a project, run by `@mocco/probe` agents at the locations it is assigned to
([ADR 0027](../adr/0027-status-probes-are-pull-based-agents.md)). This slice stores monitors and locations and
manages them over tRPC. The probe protocol (`/api/ext/v1/probe/lease|results|heartbeat`), the verdict evaluator and
the probe agent come next; until then a monitor stays `pending` and nothing checks it.

**Spec.** `monitorSpecSchema` in `@mocco/common/status` is a union by `kind`:

| Kind | Fields |
|---|---|
| `http` | `url` (http or https), `method` (`GET`, `HEAD`, `POST`), `body`, `expectedStatus` (empty means any 2xx), `keyword` with `keywordMode` (`contains`, `absent`), `latencyThresholdMs`, `timeoutMs` (1 to 30 seconds, default 10), `followRedirects` (default on), `tlsWarnDays` |
| `tcp` | `host`, `port`, `timeoutMs` |

A monitor also has `intervalSeconds` (60 to 86,400, default 60), `confirmations` and `recoveryConfirmations` (1 to
10, default 2), `quorumMode` (`majority`, `any`, `all`), one to ten locations, and the components it reports on,
each with the impact it has while the monitor is down. Request headers, which can carry secrets, aren't accepted yet.

**Locations.** A workspace sees Mocco's shared locations (`workspace_id` null: hosted regions, or the embedded probe
on a one-box install) and its own private ones. An owner or admin creates a private location with a `code` unique in
the workspace; the answer carries its token (`mpl_` and 43 base64url characters) once, and only the token's SHA-256
hash is stored. Rotating issues a new token and the old one stops working. A disabled location isn't offered to new
monitors. Shared locations are provisioned with the hosted fleet and the embedded probe, not through the console.
A monitor may use enabled shared locations and its workspace's own; any other location id is `NOT_FOUND`, so a
monitor can't be pointed at another tenant's private network. Every linked component must be on one of the
project's pages.

**State.** A new monitor is `pending` with its first round due at once (`next_round_at`). Only two writers change
`state`: the evaluator (next slice) and the operator's pause and resume. Both take the monitor's
`pg_advisory_xact_lock` (`AdvisoryLockNamespaces.statusMonitor`) inside their transaction and append a row to
`mocco_status_monitor_state_changes`. Pausing sets `paused`; resuming sets `pending` and makes a round due now. Pausing
a paused monitor, or resuming one that isn't paused, changes nothing. Editing a monitor replaces its settings,
locations and components and keeps its state. Deleting it deletes its links and history.

## Audit

These changes are appended to the workspace's audit chain, after their transaction commits:

| Action | Subject |
|---|---|
| `status.page.created`, `status.page.deleted` | `status_page` |
| `status.component.status_changed` (from, to) | `status_component` |
| `status.incident.created`, `status.incident.updated` (from, to), `status.incident.components_changed`, `status.incident.postmortem_changed` | `status_incident` |
| `status.maintenance.scheduled`, `status.maintenance.canceled` | `status_maintenance` |
| `status.maintenance.started`, `status.maintenance.completed` (by the tick, no actor) | `status_maintenance` |
| `status.monitor.created`, `status.monitor.updated`, `status.monitor.deleted`, `status.monitor.paused`, `status.monitor.resumed` | `status_monitor` |
| `status.location.created`, `status.location.token_rotated`, `status.location.disabled` | `status_location` |

Group and other component edits are not audited.

## tRPC

`status.*` is built on `productProcedure(Products.status)`: the caller must be a member of `workspaceId`,
`projectId` must belong to it, and the status product must be enabled (`FORBIDDEN` otherwise). The same procedure
maps the domain's errors: `StatusEntityNotFoundError` is `NOT_FOUND`; `StatusPageSlugTakenError`,
`IncidentTransitionError`, `MaintenanceTransitionError` and `LocationCodeTakenError` are `CONFLICT`; `MaintenanceWindowError` is
`BAD_REQUEST`. Every lookup is scoped by workspace and project, so another tenant's ids are `NOT_FOUND`. A test
calls every procedure as a non-member and with another tenant's ids, and fails if a procedure is missing from it.

| Procedures | Purpose |
|---|---|
| `pages`, `page`, `createPage`, `updatePage`, `deletePage` | Pages; `page` returns groups and components with `displayedStatus` |
| `createGroup`, `updateGroup`, `deleteGroup` | Groups |
| `createComponent`, `updateComponent`, `setComponentStatus`, `deleteComponent` | Components; `setComponentStatus` is audited |
| `incidents`, `incident`, `createIncident`, `postIncidentUpdate`, `setIncidentComponents`, `setPostmortem` | Incidents; `incident` returns the timeline and affected components |
| `maintenances`, `scheduleMaintenance`, `cancelMaintenance` | Maintenance |
| `monitors`, `monitor`, `createMonitor`, `updateMonitor`, `pauseMonitor`, `resumeMonitor`, `deleteMonitor` | Monitors; `monitor` returns its location ids, components and latest state changes |
| `locations`, `createLocation`, `rotateLocationToken`, `disableLocation` | Probe locations of the workspace (no `projectId`); the writes need an owner or admin (`FORBIDDEN` for a plain member), and `.output()` strips `token_hash`, so a token appears only in `createLocation` and `rotateLocationToken` |

Agents read the same data over MCP ([ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)); see
[MCP](#mcp) below. A mutating tool for posting an incident update, behind the workspace's switch, comes later.

## Not built yet

Checking monitors (the probe protocol, the evaluator and `@mocco/probe`), component status derived from monitors
(`status_source`) and monitor alerts; MCP tools for monitors; page `visibility`, `locale` and `theme`; the CDN host mapping
(`<slug>.status.mocco.club`) and custom domains; subscribers; incident `origin` (and a way to create or publish a
draft, which arrives with monitor-origin incidents); repo and project links on components; run links
(`suspected_run_id`, `mocco_status_incident_runs`); and gate-linked maintenance (`run_id`, `gate_id`, `overrun`,
`suppress_alerts`). Each arrives with its slice as an additive column or table.

## MCP

Agents read status pages over MCP with `mocco_status_pages_get` (each component and its `displayedStatus`),
`mocco_status_incidents_search` (open by default; by status, severity, page or title text, newest first, paged),
`mocco_status_incidents_get` (the timeline, affected components and postmortem) and `mocco_status_maintenances_search`
(scheduled and in progress by default) in `transport/mcp/tools/status.ts`: thin, read-only adapters over `getPage`,
`IncidentService.list` / `get` and `MaintenanceService.list`, behind the same checks as
`productProcedure(Products.status)` (`ProjectScope`). A page is looked up among the project's own, so another tenant's
page or incident reads like one that does not exist. Nothing on MCP declares or updates an incident yet. See
[Connect Mocco to your agent](../customer/mcp/connect.md).
