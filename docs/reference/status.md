---
title: Status page model
description: How Mocco stores a project's status pages — pages, component groups, components, incidents with their timeline and affected components, and scheduled maintenance, including windows that resuming a gate starts and the run's end completes — the incident lifecycle, deploy correlation (the runs linked to an incident), how a component's shown status is derived, the maintenance tick, how the public page is published as static snapshots (and served by self-hosters), monitors and probe locations, the @mocco/probe agent and its address policy, heartbeat monitors and their ping routes, the /v1 management API for CI and scripts with its OpenAPI description, what is audited, and the status tRPC router.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-06
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
  - packages/backend/src/domain/status/repos/gate-maintenance.repo.ts
  - packages/backend/src/domain/status/MonitorService.ts
  - packages/backend/src/domain/status/LocationService.ts
  - packages/backend/src/domain/status/ProbeService.ts
  - packages/backend/src/domain/status/TimeSeriesRetention.ts
  - packages/backend/src/domain/status/RollupService.ts
  - packages/backend/src/domain/status/uptime.ts
  - packages/backend/src/domain/status/latency-hist.ts
  - packages/backend/src/domain/status/VerdictEvaluator.ts
  - packages/backend/src/domain/status/MonitorTransitionService.ts
  - packages/backend/src/domain/status/HeartbeatService.ts
  - packages/backend/src/domain/status/heartbeat.ts
  - packages/backend/src/domain/status/heartbeat-token.ts
  - packages/backend/src/transport/ext/v1/heartbeat-ping.ts
  - packages/backend/src/domain/status/repos/incident-monitor.repo.ts
  - packages/backend/src/domain/status/consensus.ts
  - packages/backend/src/transport/ext/v1/probe.ts
  - packages/probe/src/agent.ts
  - packages/probe/src/client.ts
  - packages/probe/src/config.ts
  - packages/probe/src/http-check.ts
  - packages/probe/src/tcp-check.ts
  - packages/probe/src/address-policy.ts
  - packages/probe/src/resolve.ts
  - packages/probe/Dockerfile
  - packages/probe/src/create-agent.ts
  - packages/backend/src/runtime/probe.ts
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
  - packages/backend/src/domain/status/CorrelationService.ts
  - packages/backend/src/domain/status/ports.ts
  - packages/backend/src/domain/status/release-deploys.ts
  - packages/backend/src/domain/status/repos/incident-run.repo.ts
  - packages/backend/src/domain/status/DeployWatchService.ts
  - packages/backend/src/domain/status/subscribers.ts
  - packages/backend/src/transport/ext/v1/monitors.ts
  - packages/backend/src/transport/ext/v1/status.ts
  - packages/backend/src/transport/ext/v1/status-openapi.ts
  - packages/common/src/status-v1.ts
  - packages/sdk-core/src/status.ts
  - packages/frontend/src/components/status/status-pages.tsx
  - packages/frontend/src/components/status/page-components.tsx
  - packages/frontend/src/components/status/incidents.tsx
  - packages/frontend/src/components/status/incident-detail.tsx
  - packages/frontend/src/components/status/maintenance.tsx
  - packages/frontend/src/components/status/recent-deploys.tsx
  - packages/frontend/src/components/status/run-incidents.tsx
  - packages/frontend/src/components/status/monitors.tsx
  - packages/frontend/src/components/status/monitor-form.tsx
  - packages/frontend/src/components/status/monitor-detail.tsx
  - packages/frontend/src/components/status/heartbeat-ping.tsx
  - packages/frontend/src/components/status/locations.tsx
---

# Status page model

The status page product ([design spec](../specs/2026-09-24-status-page-design.md), issue #103) lands in slices.
This page describes what is built: operators manage a project's status pages, components, incidents and scheduled
maintenance by hand through the `status.*` tRPC router (#148), and every change is published as a static public page
(#149, [below](#public-page)). Monitors and probe locations are configured over tRPC and checked by the `@mocco/probe`
agent run at a private location or embedded in a single-node self-hosted server (#150,
[below](#monitors-and-the-probe-protocol)); a monitor's state drives its
components, opens incidents and sends alerts ([below](#what-a-state-change-does)). Each incident lists the releases
around its start and any run a person links to it, and a run lists its incidents (#154,
[below](#deploy-correlation)); after a release its monitors check every 30 seconds for 15 minutes, and a failure then
opens an incident naming the run (#155, [the deploy watch](#the-deploy-watch)). A heartbeat monitor takes pings from a
customer's job instead of probing, and goes down when the job falls silent or reports a failure (#153,
[heartbeat monitors](#heartbeat-monitors)). There are no subscribers yet.

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
zone, with the components it covers), and cancels a scheduled or in-progress one. An incident's route also lists the
deploys around it, and the run page its incidents ([deploy correlation](#deploy-correlation)). The customer guide is
[Run a status page](../customer/status/status-page.md).

Two more views read beyond the page. **Monitors** (`?tab=monitors`, `monitors.tsx`) lists the project's monitors, the
same on every page: state badge, target (`monitorTargetLabel`: the method, origin and path, never URL credentials or
query), when the state last changed and the linked components, rereading every 15 seconds. **New monitor** opens the
form (`monitor-form.tsx`) that edit reuses: HTTP (method, URL, a POST body, expected status codes, keyword present or
absent, the slow threshold, follow redirects) or TCP (host, port), the timeout, the interval (60 seconds or more),
down and up confirmations, the locations (enabled ones, plus any disabled one the monitor already uses), the quorum,
each component of each of the project's pages with its impact while down, and the incident policy. The fields are
parsed with `monitorInputSchema` before the call, so a bad field shows its zod issue, and a refused save shows the
server's error. **Heartbeat** replaces the check, timeout, interval, confirmations, locations and quorum with the period
and grace in minutes; editing offers only the kinds a monitor may stay (a heartbeat, or HTTP and TCP). Creating a
heartbeat shows its ping URL once (`heartbeat-ping.tsx`: the console's origin plus `/api/ext/v1/ping/{token}`) with
`curl`, crontab, `/start` plus exit code and `@mocco/node` snippets, before the form closes. The list shows a heartbeat
as its period and last ping. A monitor's route (`/status/monitors/[monitorId]`, `monitor-detail.tsx`) shows its settings, the
open monitor incident (with a Draft badge), the latest ten rounds and 50 state changes with their reasons, **Watching
after a deploy** with the run while `watch_until` is ahead, and edit, pause or resume, and delete. A heartbeat's route shows its period and grace, its last ping, its last run time
(or "running since" after a `/start`), and why each change happened (a ping, a failure with its exit code, or no ping in
time) instead of rounds and locations, and **Replace ping URL** (`rotateHeartbeatToken`, after a confirmation) shows
the new URL once. It doesn't chart
the monitor's uptime and p50/p95 latency yet, though the read returns them (`history`, [tRPC](#trpc)). **Locations**
(`?tab=locations`, `locations.tsx`) lists the workspace's locations (kind, code, last seen, agent version, disabled)
to every member; owners and admins (`useWorkspaceAdmin`) create a private location, rotate its token and disable it.
A new or rotated token is shown once, kept only in component state, with the `docker run` and `npx @mocco/probe`
commands that use it and the page's origin as `MOCCO_URL`. The customer guide is
[Monitor your service](../customer/status/monitor-your-service.md).

## Tables

Every table is `mocco_status_*`, carries `workspace_id`, and belongs to a project through its page
([ADR 0013](../adr/0013-mocco-is-a-multi-product-platform.md)).

| Table | Holds |
|---|---|
| `mocco_status_pages` | A page: `slug` and `title`. The slug is unique across all workspaces, because it becomes the public host label; it follows the project handle pattern (lowercase letters, digits and inner hyphens, 1 to 40 characters), checked in zod and in the DB. `dirty_at` (a change is waiting to be published), `published_version` and `published_at` track the [public page](#public-page) |
| `mocco_status_component_groups` | A heading on a page ("API", "Dashboard"), with `position` |
| `mocco_status_components` | A part of the service: `name`, `description`, optional `group_id`, `position`, and `status`, the one an operator sets by hand |
| `mocco_status_incidents` | `title`, `status`, `severity` (`minor`, `major`, `critical`), `visibility` (`published`, or `draft`, which never reaches the public page), `started_at`, `identified_at`, `resolved_at`, `postmortem_md`, `origin` (`manual`, `monitor`, `deploy_watch`), `suspected_run_id` (the run whose [deploy watch](#the-deploy-watch) opened it; `SET NULL` when the run is deleted), `created_by_user_id` |
| `mocco_status_incident_updates` | The incident's timeline: `status` and `body_md` per update, append-only |
| `mocco_status_incident_components` | The components an incident affects, with `impact` (`degraded`, `partial_outage`, `major_outage`) |
| `mocco_status_maintenances` | A window: `title`, `body_md`, `scheduled_start`/`scheduled_end` (end after start, DB-checked), `status`, `actual_start`/`actual_end`. A window a resumed gate started also has `run_id` and `gate_id` (both `SET NULL` when the run is deleted; one window per gate and page, a partial unique index), `overran_at` and `end_note` ([maintenance from gated runs](#maintenance-from-gated-runs)) |
| `mocco_status_gate_maintenances` | A gate that announces maintenance on a page: `gate_name` (unique per page), `title`, `expected_minutes` (1 to 1440, DB-checked) and `component_ids` |
| `mocco_status_maintenance_components` | The components a window covers |
| `mocco_status_page_snapshots` | A published version of the public page: `version` (per page, from 1), `etag`, the snapshot `body` (jsonb), `built_at`, `uploaded_at` and `upload_error`. The last 20 versions are kept |
| `mocco_status_locations` | Where probes run: `code`, `name`, `kind` (`hosted`, `private`, `embedded`), `token_hash`, `last_seen_at`, `agent_version`, `disabled_at`. `workspace_id` is set for a private location and null otherwise (DB-checked) |
| `mocco_status_monitors` | A check of a project: `key` (the caller's name for a monitor made through the [`/v1` API](#the-v1-management-api), unique in the project and null for one made in the console; lowercase letters, digits and inner dots, underscores and hyphens, 1 to 100 characters, DB-checked; migration 0069), `name`, `kind` (`http`, `tcp`, `heartbeat`), `spec` (jsonb; a heartbeat's holds only its kind), `interval_s` (60 or more, DB-checked), `confirmations`, `recovery_confirmations`, `quorum_mode`, `incident_policy` (`none`, `draft`, `publish`; default `draft`), `state`, `state_changed_at`, `next_round_at`, the streaks `consecutive_fails` and `consecutive_oks`, and the [deploy watch](#the-deploy-watch) `watch_until`, `watch_interval_s` (30 or more; both set or both null, DB-checked) and `watch_run_id`; for a [heartbeat](#heartbeat-monitors), `heartbeat_token_hash` (unique), `heartbeat_period_s`, `heartbeat_grace_s`, `last_ping_at`, `last_start_at` and `last_duration_ms`. A DB check (`mocco_status_monitors_heartbeat_check`, migration 0068) requires a heartbeat to have the token hash, a period and a grace of 60 seconds or more and both confirmations at 1, and a probe kind to have no token, period, grace or pings |
| `mocco_status_monitor_locations` | The locations a monitor runs at |
| `mocco_status_component_monitors` | The components a monitor reports on, with `impact_when_down` |
| `mocco_status_incident_runs` | The runs linked to an incident ([deploy correlation](#deploy-correlation)): `relation` (`suspected`, `before_window`, `fix`, `manual`), `score` (a suggestion's), `linked_by_user_id` (null for a suggestion). Keyed by (incident, run), with an index on `run_id` for the run's side; deleting the incident or the run deletes the link |
| `mocco_status_incident_monitors` | The incident a monitor opened: `incident_id`, `monitor_id`, `closed_at` (set when the monitor recovers). A partial unique index on `monitor_id` where `closed_at` is null keeps one open incident per monitor |
| `mocco_status_monitor_state_changes` | Every change of a monitor's state: `from_state`, `to_state`, `at`, `round_at`, `reason`. Append-only, and the source of truth for downtime |
| `mocco_status_round_verdicts` | One closed round of a monitor: `verdict` (`ok`, `degraded`, `fail`, `unknown`), `ok_count`, `fail_count`, `no_data_count`, `p50_latency_ms`, `closed_at`. Key (monitor, round); partitioned by day like the raw results and kept 30 days |
| `mocco_status_rollups_hourly` | One monitor's hour ([uptime rollups](#uptime-rollups)): `rounds`, `ok_rounds`, `fail_rounds`, `unknown_rounds`, `down_seconds`, `latency_sum_ms`, `latency_count` and `latency_hist`. Key (monitor, hour); kept 90 days |
| `mocco_status_rollups_daily` | One monitor's UTC day: `rounds`, `ok_rounds`, `down_seconds`, `maintenance_seconds`, `uptime_ratio` (numeric(7,6), null when nothing could be measured), `latency_hist` and `p95_ms`. Key (monitor, day); kept forever |
| `mocco_status_component_days` | One component's UTC day, for the 90-day bars: `worst_status`, `down_seconds`, `uptime_ratio` (null when no monitor reports on it) and `incident_ids`. Key (component, day); kept forever |
| `mocco_status_probe_leases` | One check a location owes for one round: `monitor_id`, `location_id`, `round_at`, `leased_at`, `expires_at`, `reported_at`. Unique on (monitor, location, round) |
| `mocco_status_check_results` | Raw results, one per (monitor, round, location): `outcome`, `error_kind`, `status_code`, `latency_ms`, `timings`, `tls_expires_at`, `detail` (512 characters at most), `lease_id`, `received_at`. Partitioned by UTC day on `round_at` ([below](#time-series-and-their-partitions)); no uuid key and no foreign keys, like the audit log's exception |

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

## Deploy correlation

An incident lists the deploys around it, and a run lists the incidents it is linked to. `CorrelationService` owns
both sides; it reads releases and runs through the `DeploySource` port (`domain/status/ports.ts`), which the
composition root implements over the release registry and execution repos (`release-deploys.ts`), so neither the
execution nor the project domain depends on status.

**What counts as a deploy.** A recorded [release](./releases.md): a run that succeeded and passed at least one
resumed gate, recorded for the projects its repo is linked to. The design's first rule (any succeeded run) predates
the registry and named the missing production marker as an open question; the registry is that marker, so a CI
run that never passed a gate is not suggested. Any run of the workspace can still be linked by hand.

**Scope.** An incident belongs to a project through its page. When the project links repos, only its releases of
repos it still links count, so a release of an unlinked repo (or of another project) is never suggested. When it
links none, every release of the workspace counts. Another workspace's runs never appear: every query is
workspace-scoped and the run's side checks the run belongs to the caller's workspace. Components have no repo links
of their own yet, so the project's links stand in for them.

**Window and score.** Releases that finished in `[started_at - 2h, started_at + 5m]` (`CorrelationWindow` in
`@mocco/common/status`, the same for every page) are scored `1 / (1 + minutes / 10)`, where `minutes` is how far
from the start they finished, either side; a release of the incident's project's linked repos counts 1.5 times.
One run released for several projects keeps its best score. The best 20 are kept: the top one as `suspected`, the
others as `before_window`. Suggestions are computed when an incident opens, by hand or by a monitor (after its
audit entry, never failing the incident), and again on demand (`correlateIncident`), which replaces the suggestions
and keeps every link a person made.

**Links by hand.** A person links any run of the workspace as `manual` (default) or `fix` (the run that resolved
it); linking a suggested run turns it into their link. Unlinking removes a suggestion or a person's link. Both are
audited. A suggestion that was unlinked comes back if the suggestions are recomputed.

**Console.** The incident page has a **Recent deploys** panel (`recent-deploys.tsx`): each linked run with its
relation, score (or "linked by a person"), repo and commit, a link to the run, and **Unlink**; a form that links one of
the workspace's 50 latest runs (`run.list`) as related (`manual`) or `fix`; and **Recompute**. The run page gets an
**Incidents** panel (`run-incidents.tsx`) through `runIncidents`, shown only when the status product is on.

An incident a [deploy watch](#the-deploy-watch) opened has `suspected_run_id`, and that run's score counts 2 times
(with the 1.5 for a linked repo, 3 times). The factor comes from the incident, so recomputing keeps it. Not built yet:
a per-page window.

### The deploy watch

Right after a release, the released project's monitors check every 30 seconds for 15 minutes (`DeployWatch` in
`@mocco/common/status`), so a deploy that breaks a check is seen within a minute and the incident it opens names the
run.

**Trigger.** The `status.deploy_watch` subscriber on `deploy.released` (`domain/status/subscribers.ts`), not
`run.succeeded`. A release is a run that succeeded and passed a resumed gate ([release registry](./releases.md)), so a
CI run that never reached a production gate starts no watch, and the event already names every project the run's repo
is linked to. The spec's `CorrelationService.onRunFinished` predates the registry.

**Linkage.** A monitor belongs to a project, and the release names projects, so the watch covers every monitor of the
released projects (`projectIds`) that isn't paused. Components have no repo links yet; when they do, the watch can
narrow to the monitors on the affected components.

**Starting.** `DeployWatchService.startWatch` sets `watch_until` to 15 minutes after the run finished
(`releasedAt`), `watch_interval_s` to 30 and `watch_run_id`, and pulls a round that isn't due yet to now; a round
already due or open stays as it is. Each monitor is changed under its state lock. The window counts from the release
rather than from delivery, so a redelivered event keeps the same window and a release delivered more than 15 minutes
late (by the reconcile job) starts nothing. A monitor already watching a later release keeps that watch.

**Rounds.** A round is watched when it starts before `watch_until`. The evaluator schedules the round after a watched
one at `watch_interval_s`, and the first round at or past `watch_until` clears all three columns and schedules the next
one at the monitor's own interval. No job ends the watch.

**A failure.** A `down` change in a watched round:

- with no open monitor incident, opens one ([what a state change does](#what-a-state-change-does)) with
  `origin = 'deploy_watch'`, `suspected_run_id` set to the watched run, and the first update "The monitor "API health"
  started failing within N min of a deploy." (the body can be public, so it never names the repo or the run). The
  correlation that follows links the run as `suspected` in `mocco_status_incident_runs`, with the 2x factor;
- with an open incident (an outage that began before the deploy), keeps that incident as it is;
- in both cases, and when `incident_policy` is `none`, appends `status.post_deploy_check_failed` to the run's timeline
  (`mocco_run_events`) with `monitorId`, `monitorName`, `projectId`, `incidentId` and `incidentTitle` (or null),
  `incidentOpened`, `minutesAfterRelease` and the console `linkPath`. Status writes it through the `RunTimeline` port
  (`createRunTimeline` in `release-deploys.ts`), so execution never depends on status. A failed append is logged and
  never undoes the change.

It changes nothing about the run: no state, no rollback. An automatic rollback on a failed post-deploy check is an
enforcement change and needs its own ADR.

**Checking now.** A pipeline step can ask for a round right away with `POST /v1/monitors/{id}/check`
([public API](./public-api.md#routes)): a secret key with `status:write` of the project that owns the monitor, limited
to 10 a minute per key. `MonitorService.requestCheck` takes the monitor's state lock, pulls a round that isn't due yet
to now (one already due or open stays) and answers with the round's time; it changes no state or streak, and the
verdict follows as for any round, so inside a watch a failure is attributed like the others. Another project's monitor
is `404`; a paused one is `MonitorPausedError` (`409`), since it has no rounds until it is resumed. It isn't audited:
like a scheduled round, it changes nothing an operator set.

The incident's `suspected_run_id` is a column rather than only the `suspected` link: suggestions are replaced on every
recompute and a person can unlink them, while which watch opened the incident is a fact that has to last, and it is
what the 2x factor reads. Incidents a monitor opened before migration 0066 read `origin = 'manual'`.

## What a component shows

A component's `status` is what an operator reported. The status the page shows is derived
(`deriveComponentStatus`): the worst of that status, the impacts of the unresolved incidents affecting the
component, what its linked monitors put on it, and `maintenance` while a window covering it is in progress. A
monitor that is `down` or `recovering` (an outage runs until the next `up`) puts the link's `impact_when_down` on the
component, a `degraded` one puts `degraded`, and any other state (`suspect` is unconfirmed) puts nothing. The order is
`operational` < `maintenance` < `degraded` < `partial_outage` < `major_outage`, so an outage during a maintenance
window still shows as an outage. `status.page` returns each component with `displayedStatus`; the public page counts
published incidents only, but every monitor.

## Maintenance

A window is scheduled with its components and starts as `scheduled`. The `status.maintenance.tick` job runs every
minute as a platform schedule ([jobs](./jobs.md)) and calls `MaintenanceService.tick(now)`:

1. Every `scheduled` or `in_progress` window whose end has passed becomes `completed`. A window the tick never saw
   start goes straight to `completed`.
2. Every `scheduled` window whose start has passed becomes `in_progress`.

Each step is one conditional `UPDATE`, so overlapping ticks can't move a window twice. `actual_start` and
`actual_end` record when the tick made the change. An operator can cancel a `scheduled` or `in_progress` window
(one in progress ends now). A completed or canceled window can't be canceled (`MaintenanceTransitionError`,
`CONFLICT`). Windows can't be edited yet: cancel the window and schedule a new one.

### Maintenance from gated runs

A page can name gates that announce maintenance (#158): `status.setGateMaintenance` stores a gate name, a title,
the expected minutes and the components it covers (`mocco_status_gate_maintenances`, one per gate name and page;
setting the same gate name again replaces it). The mapping lives in Mocco, not in `.mocco.yml`; a `maintenance:` key
on a gate item waits for the [ADR 0010](../adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md) review.

1. **Start.** The `status.maintenance.gate_resumed` subscriber on `gate.resumed` calls
   `MaintenanceService.startForGate`. It reads the run through the `RunSource` port (`release-deploys.ts`, over the
   execution and project repos) and finds the gate maintenances with the gate's name on the pages of every project the
   run's repository is linked to. For each one it inserts a window `in_progress` from now, with `scheduled_end` now
   plus the expected minutes, `run_id`, `gate_id`, and the components that are still on the page. A redelivered event
   starts no second window (the `(gate_id, page_id)` unique index), and a run that already finished when the event is
   delivered starts none. Audited as `status.maintenance.started` with `runId`, `gateId` and `gateName`.
2. **Complete.** `run.succeeded`, `run.failed` and `gate.rejected` (a later gate rejected the run) complete the run's
   windows in progress (`completeForRun`): `actual_end` is now and, unless the run succeeded, `end_note` says how it
   ended ("Ended when the run failed.", "… was canceled.", "… a later gate rejected the run."). A canceled run
   publishes no event, and an event can be lost, so each tick also reads the runs of every run-linked window in
   progress and completes those whose run is `succeeded`, `failed`, `canceled` or `rejected`, with the same note.
   Audited as `status.maintenance.completed` with `runId`, `runState` and `endNote`.
3. **Overrun.** The tick's first step skips run-linked windows: they end with their run, not at `scheduled_end`.
   Instead, a run-linked window still in progress at `scheduled_end` gets `overran_at` once, is audited as
   `status.maintenance.overran`, and publishes the `status.maintenance.overran` alert ([events](./events.md)), which
   the `mocco` notification preset routes. The window stays in progress, so the page keeps showing maintenance until
   the run finishes. When the run is deleted, `run_id` becomes null and the tick completes the window at its
   `scheduled_end`.

A run-linked window is an ordinary window in progress for everything else: its components show `maintenance`, a
monitor's incident on them is held back as a draft and its alerts say "(during maintenance)"
([what a state change does](#what-a-state-change-does)), the time it ran (overrun included) is left out of uptime
([uptime rollups](#uptime-rollups)), and an operator can cancel it. Deleting a gate maintenance leaves the windows it
started alone.

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
by a hash of its id, and no author or user appears. Postmortems are not published yet.

**The 90-day bars.** Each component carries `uptime`: `days`, the last 90 UTC days ending on the build's day, oldest
first, each with `day`, `status` (the day's `worst_status` from its [component day](#uptime-rollups)) and `uptime` (its
`uptime_ratio` as a percentage with two decimals, rounded down so a day with any downtime never shows 100%), and
`percent`, the mean of the days' percentages. A day without a row has no data (`status` and `uptime` null): the
component didn't exist yet, or the rollup hasn't reached it, so history starts when tracking did. A day of a
component no monitor reports on has a status but no uptime. The page draws one bar per day in its status colour
(grey for no data) and writes each bar's day, status and uptime as escaped text, in its tooltip and as hidden text, so
it reads without JavaScript or styles; under the bars it shows the mean ("99.95% uptime", or "No uptime data yet").
The page is republished when a bar changes: the daily rollup compares each component day it writes with the stored one
and, when the status or the shown percentage differs (or the day is new), marks the component's page dirty in the same
transaction (`SnapshotScheduler.change`), so the debounced publish job builds the next version. A rollup that moves
nothing visible publishes nothing; a new day's first rollup, just after midnight, republishes every page once.

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
([ADR 0027](../adr/0027-status-probes-are-pull-based-agents.md)), or a [heartbeat](#heartbeat-monitors) that a job pings. Monitors and locations are managed over tRPC, and
agents lease and report rounds over the [probe protocol](#probe-protocol); the
[verdict evaluator](#verdicts-and-the-state-machine) closes each round and moves the monitor's state and schedule. The
[probe agent](#the-probe-agent) runs the checks at private locations, or inside a single-node self-hosted server as
[the embedded probe](#the-embedded-probe); there is no hosted fleet yet.

**Spec.** `monitorSpecSchema` in `@mocco/common/status` is a union by `kind`:

| Kind | Fields |
|---|---|
| `http` | `url` (http or https), `method` (`GET`, `HEAD`, `POST`), `body`, `expectedStatus` (empty means any 2xx), `keyword` with `keywordMode` (`contains`, `absent`), `latencyThresholdMs`, `timeoutMs` (1 to 30 seconds, default 10), `followRedirects` (default on), `tlsWarnDays` |
| `tcp` | `host`, `port`, `timeoutMs` |

`monitorInputSchema` also takes `{ kind: 'heartbeat', periodSeconds, graceSeconds }`; it isn't part of
`monitorSpecSchema`, which is what probes run and what a lease carries. A heartbeat has no locations, and every probe
kind has at least one (the schema refuses both mistakes).

A monitor also has `intervalSeconds` (60 to 86,400, default 60), `confirmations` and `recoveryConfirmations` (1 to
10, default 2), `quorumMode` (`majority`, `any`, `all`), one to ten locations, and the components it reports on,
each with the impact it has while the monitor is down, and an `incidentPolicy` (`none`, `draft` or `publish`, default
`draft`; see [below](#what-a-state-change-does)). Request headers, which can carry secrets, aren't accepted yet.

**Locations.** A workspace sees Mocco's shared locations (`workspace_id` null: hosted regions, or the embedded probe
on a one-box install) and its own private ones. An owner or admin creates a private location with a `code` unique in
the workspace; the answer carries its token (`mpl_` and 43 base64url characters) once, and only the token's SHA-256
hash is stored. Rotating issues a new token and the old one stops working. A disabled location isn't offered to new
monitors. Shared locations are provisioned with the hosted fleet and the embedded probe, not through the console.
A monitor may use enabled shared locations and its workspace's own; any other location id is `NOT_FOUND`, so a
monitor can't be pointed at another tenant's private network. Every linked component must be on one of the
project's pages.

**State.** A new monitor is `pending` with its first round due at once (`next_round_at`). Only three writers change
`state`: the evaluator, a heartbeat's pings, and the operator's pause and resume. All take the monitor's
`pg_advisory_xact_lock` (`AdvisoryLockNamespaces.statusMonitor`) inside their transaction and append a row to
`mocco_status_monitor_state_changes`. Pausing sets `paused`; resuming sets `pending` and makes a round due now (a
heartbeat's deadline starts over from the resume instead). Pausing
a paused monitor, or resuming one that isn't paused, changes nothing. Editing a monitor replaces its settings,
locations and components and keeps its state. Deleting it deletes its links and history.

### Probe protocol

`/api/ext/v1/probe/*` on the ext app ([ADR 0011](../adr/0011-external-api-surface-architecture.md)), under the public
`/v1` surface but not authenticated by an API key: the bearer is a location token. A missing or unknown token, or the
token of a disabled location, is `401` with problem type `invalid_location_token`, before anything is read. Calls are
limited to 600 a minute per location. `ProbeService` decides everything; the routes only parse
(`probeLeaseRequestSchema`, `probeResultsRequestSchema`, `probeHeartbeatRequestSchema` in `@mocco/common/status`). The
answers have schemas there too (`probeLeaseResponseSchema`, `probeResultsResponseSchema`): the agent parses with them,
and the route test checks the routes' answers against them.

| Route | Body | Answer |
|---|---|---|
| `POST /lease` | `agentVersion`, `capacity` (1 to 200, default 50) | `200 { leases: [{ leaseId, monitorId, roundAt, expiresAt, spec }], pollAfterMs }` |
| `POST /results` | `results`: 1 to 200 of `{ leaseId, monitorId, roundAt, outcome (ok, fail), errorKind?, statusCode?, latencyMs?, timings? (any of dns, connect, tls, ttfb), tlsExpiresAt?, detail? }` | `202 { accepted, duplicates, rejected: [leaseId] }` |
| `POST /heartbeat` | `agentVersion`, `inflight` | `204` |

**Leasing.** A lease call takes the rounds due at the location within the next 60 seconds: the monitor's
`next_round_at`, for monitors assigned to the location and not paused. A private location only gets its own
workspace's monitors, even if an assignment row says otherwise. In one transaction, the location's assignment rows are
selected `FOR UPDATE SKIP LOCKED` (so two agents of one location split the work instead of waiting on each other) and
the leases are inserted `ON CONFLICT DO NOTHING` on the unique (monitor, location, round), so a round is never leased
twice to one location. Other locations lock other rows and get their own lease of the same round. A lease expires at
the round's time plus the check's timeout plus 15 seconds. `pollAfterMs` is 15 seconds, or 0 when the batch was full.

**Results.** A result is stored only if its lease belongs to the reporting location, names the same monitor and
round, hasn't been reported, and arrives between the round's time and the lease's expiry. A result for another
location's lease, another monitor or round, or one too early or too late is listed in `rejected` and stored nowhere, so a stolen token can't speak for another location. A
result for a lease already reported, or repeated in the same batch, counts as a duplicate: retrying a batch is safe.
Results are inserted `ON CONFLICT DO NOTHING` on (monitor, round, location), and their leases are then marked
`reported_at`. A probe reports `ok` or `fail`; `no_data` is reserved for the evaluator, for a lease nobody reported.
After storing results, the report runs the evaluator for those monitors, so a round every location has reported
closes at once; a failure there is logged and never fails the report.

**Seen.** Every lease call and heartbeat sets the location's `last_seen_at` and `agent_version`.

### The probe agent

`@mocco/probe` (`packages/probe`, MIT, `mocco-probe` bin) is one location's agent: a stateless Node 22 process with no
database. It runs the [protocol](#probe-protocol) in a loop:

1. **Lease** with capacity `MOCCO_PROBE_CONCURRENCY`, then wait the answer's `pollAfterMs` (0 when the batch was full)
   before the next lease. A lease whose spec it can't parse (a monitor kind newer than the agent) is skipped and
   logged, so its round is `no_data` for this location.
2. **Run** each check at its `roundAt` plus up to 2 seconds of jitter, at most `MOCCO_PROBE_CONCURRENCY` at once.
3. **Report** results in batches of up to 200, a second after the first one is ready. A failed post is retried with
   backoff; a result whose lease has expired is dropped, since the server would refuse it.
4. **Heartbeat** every 30 seconds with the number of checks in flight.

A failed lease call backs off exponentially with jitter (1 second doubling to 60). A `401` stops the agent with exit
code 1: the token is wrong, rotated, or its location is disabled. On `SIGTERM` or `SIGINT` it stops leasing, drops
checks that haven't started (their rounds become `no_data`), waits for running ones and posts their results, then
exits 0. It logs one JSON line per event to stdout.

| Variable | Default | Meaning |
|---|---|---|
| `MOCCO_URL` | (required) | Mocco's origin, e.g. `https://www.mocco.work`; the agent calls `/api/ext/v1/probe/*` on it |
| `MOCCO_PROBE_TOKEN` | (required) | The location token (`mpl_…`), shown once by `createLocation` or `rotateLocationToken` |
| `MOCCO_PROBE_CONCURRENCY` | `20` | Checks run at once, and the lease capacity (1 to 200) |
| `MOCCO_PROBE_HOSTED` | `false` | `true` on Mocco's hosted fleet: apply the address block list below |

**Checks.** An HTTP check sends the spec's method and body with `User-Agent: mocco-probe/<version>` through undici
(imported only in `http-check.ts`, lint-enforced). It passes when the final status is in `expectedStatus` (any 2xx
when empty) and the keyword rule holds; the keyword is looked for in the first megabyte of the body only. It follows up
to five redirects itself (a 303, or a 301/302 after a POST, continues as a GET); a sixth, or a redirect to a scheme
other than http or https, fails with `status`. `latencyMs` is the time to the final response's headers, redirects
included; an answer over `latencyThresholdMs` still passes, with `errorKind: latency`, and the evaluator decides
`degraded`. `timings` has the final connection's `dns`, `connect`, `tls` and `ttfb`. An https check reports the
certificate's `tlsExpiresAt`, and inside `tlsWarnDays` its `detail` says how many days are left; an invalid or
expired certificate fails the handshake with `tls`. A TCP check resolves the host and passes when a connection opens.
The spec's `timeoutMs` bounds the whole check, name resolution included (`timeout`). Other failures are `dns` or
`connect`.

**Address policy.** A hosted probe (`MOCCO_PROBE_HOSTED=true`) refuses targets that aren't on the public internet:
0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local, with the metadata address 169.254.169.254),
172.16/12, 192.168/16, 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24, 192.88.99/24, multicast and
240/4; ::, ::1, fc00::/7 (with fd00::/8 and fd00:ec2::254), fe80::/10, fec0::/10, ff00::/8, 64:ff9b:1::/48, 100::/64,
2001::/32 (Teredo), 2001:db8::/32 and 2002::/16 (6to4), and IPv4-mapped forms of the IPv4 ranges (`address-policy.ts`).
Every connection resolves its host first, refuses it if any address it resolves to is blocked, and connects to the
address it checked, never to the name again; redirects are followed by the agent, so every hop goes through the same
step. A name that resolves to a public address for the check and a private one a moment later (DNS rebinding) never
gets a second lookup. A refused target fails with `connect` and a `detail` naming the address. Private locations skip
the list: reaching private targets is their purpose. Nothing in the lease says whether a location is hosted yet, so
the fleet sets the variable.

**Running a private location.** An owner or admin creates one in the console's Locations view (or with the
`status.createLocation` procedure) and keeps the token it shows once. Then, on a machine that can reach the targets and
make outbound HTTPS calls to Mocco:

```bash
MOCCO_URL=https://www.mocco.work MOCCO_PROBE_TOKEN=mpl_... npx @mocco/probe
# or the container (packages/probe/Dockerfile, built from the repository root)
docker build -f packages/probe/Dockerfile -t mocco-probe .
docker run -d --restart unless-stopped -e MOCCO_URL=https://www.mocco.work -e MOCCO_PROBE_TOKEN=mpl_... mocco-probe
```

Neither the npm package nor `ghcr.io/fi-workers/mocco-probe` is published yet, so for now run it from a checkout
(`yarn probe build && node packages/probe/dist/cli.js`) or build the image yourself. Add the location to a monitor's
`locationIds`; the location's `last_seen_at` and `agent_version` show it is polling. Running two agents with one token
splits that location's work between them.

### The embedded probe

A single-node self-hosted install can run the probe inside the server instead of as a second process
([ADR 0027](../adr/0027-status-probes-are-pull-based-agents.md) §6). With `STATUS_PROBE_EMBEDDED=true` the server runs
`@mocco/probe`'s own loop and checks (`createAgent` from `@mocco/probe/create-agent`; `runtime/probe.ts` is the
composition root) as one location. Only the transport differs from the bin: instead of HTTP with a token, the loop
calls `ProbeService` directly as that location, so leasing, result matching and the inline evaluation are the same
code the `/v1/probe` routes run.

- **Its location** is the shared `embedded` location (`code` `embedded`, named "This server", `workspace_id` null),
  created on first start by `LocationService.ensureEmbedded` and reused after (an insert that does nothing when it
  exists, so two starts get one row). Every workspace on the install can assign it to monitors, like a hosted region.
  Its token is generated and thrown away, because nothing authenticates as it over HTTP. Disabling the location
  keeps the embedded probe off. It applies no address block list: like a private location, it checks the install's
  own network.
- **When it starts:** with the first authorized job tick after the server boots (`/api/ext/internal/jobs/tick`, which a
  self-host cron already calls every minute, and which the evaluator needs anyway). The tick calls
  `ensureEmbeddedProbe()`, which starts the loop once per process and does nothing after that. It decides
  synchronously, so concurrent ticks can't start two loops, and it keeps its handle on `globalThis` so a module
  reloaded by the dev server doesn't start another. `STATUS_PROBE_CONCURRENCY` (default 20) bounds the checks run at
  once.
- **Never on Vercel:** with `VERCEL_ENV` set it logs one warning and never starts. A function's process is frozen
  between requests and runs as many instances, so a background loop there would stall or multiply. Hosted
  deployments use probe locations instead.
- **One box:** it is meant for one server process. A second process with the flag (another replica) starts its
  own loop as the same location, which is safe but redundant: the two split that location's rounds through the same
  `SKIP LOCKED` leasing, and a round is never leased twice to one location, so nothing is checked twice. Set the
  flag on one process only.
- **Stopping:** on `SIGTERM` or `SIGINT` the loop stops leasing and drops checks that haven't started. Next's own
  signal handler then exits the process, so a check still running may go unreported. Either way the round is
  `no_data` for this location, which never counts as downtime. A loop that fails (a lost database) is logged and
  not restarted until the process restarts.

### Verdicts and the state machine

The `status.evaluate` job runs every minute (`VerdictEvaluator`), and the results route runs it for the monitors it
just stored results for. A monitor's current round is its `next_round_at`. It closes when every enabled location
assigned to the monitor has reported, or once the round's deadline (its time, the check's timeout and the 15-second
grace, when its leases expire) has passed. A location that sent nothing is `no_data`. The evaluator handles at most 500
rounds a run, oldest first.

The round's verdict comes from the pure `tallyRound` in `consensus.ts`. Only the locations that reported count:
the quorum is half of them rounded up for `majority`, one for `any`, all of them for `all`, and never less than one,
so a single location goes through the same rule. `fail` when at least a quorum failed (checked first, so a tie under
`majority` fails); `ok` when a quorum passed, or `degraded` when a quorum of passing checks was slower than the HTTP
spec's `latencyThresholdMs`; otherwise `unknown`, including when nobody reported.

`nextState` then moves the monitor:

| From | `fail` | `ok` / `degraded` |
|---|---|---|
| `pending`, `up`, `degraded`, `suspect` | `suspect` with an immediate recheck, or `down` once `confirmations` rounds in a row failed | `up` / `degraded` |
| `down`, `recovering` | `down` | `recovering`, or `up` / `degraded` once `recovery_confirmations` rounds in a row passed |

An `unknown` round changes nothing: not the state, not the streaks. `no_data` can never take a monitor down. A
paused monitor has no rounds.

Each close is one transaction under the monitor's advisory lock (the same one pause and resume take). It re-reads
the monitor and skips the round if another evaluator closed it meanwhile. It inserts the verdict, sets the state and
streaks, and moves `next_round_at` to one interval after the round (`watch_interval_s` during a
[deploy watch](#the-deploy-watch)), or to now when that is already past or when the monitor just became `suspect` (the
recheck). When the state moved, it appends a state change with the round and a
`reason` carrying the verdict and counts. Probes then lease the next round as usual.

### Heartbeat monitors

A heartbeat (#153) checks nothing itself: a customer's cron job or worker pings Mocco, and the monitor goes down when
the pings stop or report a failure. It has no locations, probes, rounds or verdict rows.

**Token.** Creating a heartbeat generates its ping token, `mhb_` and 43 base64url characters (256 random bits,
`heartbeat-token.ts`), returned once as `heartbeatToken` by `createMonitor`; only its SHA-256 is stored, in
`heartbeat_token_hash`, which every read strips (`MonitorView`). `rotateHeartbeatToken` issues a new one (audited as
`status.monitor.heartbeat_token_rotated`) and the old one stops working at once.

**Pings.** `GET` or `POST` on the ext app's `/v1/ping/{token}` ([public API](./public-api.md#routes)), so `curl` or
`wget` is enough; the token is the only credential, no API key:

| Route | Means |
|---|---|
| `/v1/ping/{token}` | The job finished |
| `/v1/ping/{token}/start` | The job started: records `last_start_at`, moves neither the state nor the deadline |
| `/v1/ping/{token}/fail` | The job failed |
| `/v1/ping/{token}/{exitCode}` | The job exited with this code (0 to 255): 0 is a success, anything else a failure |

The route answers `200 OK`. A token of the wrong shape, an unknown or rotated token, and an exit code over 255 get the
ext app's own `404`, byte for byte the answer to a route that doesn't exist, so a ping can't probe for tokens. Pings
are limited to 5 every 5 seconds per token (a hash of it, counted before the lookup, so unknown tokens are limited
the same way) and 600 a minute per client address. `HeartbeatService.ping` looks the hash up, takes the monitor's
state lock, and checks the hash again under it (a rotation in between makes the old token not found).

**Silence.** A heartbeat's `next_round_at` is its silence deadline: the last completion ping, or its creation or
resume, plus `heartbeat_period_s` and `heartbeat_grace_s` (each 60 seconds or more; the period up to 31 days, the grace
up to 7; defaults one hour and five minutes; `interval_s` mirrors the period). The evaluator's per-minute scan picks it
up like a due round once the deadline has passed and takes the monitor down (`reason` `{ by: 'evaluator', cause:
'silence', lastPingAt }`), then sets the next deadline a period and grace later, so a heartbeat that stays silent stays
`down` without a new change. A heartbeat that was never pinged goes down a period and grace after it was created.

**The state machine.** Each completion ping is a verdict: a success is `ok`, `/fail` or a non-zero exit code is `fail`.
Pings and silence go through the same `nextState` as probe rounds, with `confirmations` and `recoveryConfirmations`
fixed at 1 (the service sets them and a DB check holds them): a ping is the job's own report, not a sample a network
blip can spoil, and silence has already waited out the grace, so a second confirmation would only delay a real
alert by a whole period. So a failure or silence is `down` at once and the next success is `up`. The ping records
`last_ping_at` and, when a `/start` came after the previous completion, `last_duration_ms` (null otherwise), and the
deadline restarts from the ping. The state change's `reason` is `{ by: 'heartbeat', cause: 'success' | 'fail',
exitCode? }`.

**Paused.** A paused heartbeat still answers `200` and records its pings and durations, so the console shows the job
is alive, but its state doesn't move and silence isn't evaluated. Resuming starts a fresh deadline from the resume, so
a ping missed while paused never takes it down.

**What doesn't apply.** Probes never lease a heartbeat (the lease query skips the kind, even if an assignment row
existed), a deploy watch skips it, and `POST /v1/monitors/{id}/check` refuses it (`MonitorKindError`, `409`): it has no
rounds. A monitor can't switch between a heartbeat and a probe kind (`MonitorKindError`); editing a heartbeat's period
and grace moves the deadline it is waiting on, counted from the same moment.

Everything after a change is shared with probe monitors: [what a state change does](#what-a-state-change-does)
(components, incidents, audit, alerts; the alert's description says "No ping for N min" or "The job exited with code
N"), and the [rollups](#uptime-rollups), which read downtime from the state changes, so a heartbeat's outage counts in
its daily uptime, its components' days and the 90-day bars like any other.

### What a state change does

After a change commits, the evaluator calls its `onStateChange` port, which `compose.ts` binds to
`MonitorTransitionService.react`; the evaluator itself knows nothing of pages, incidents or notifications. A failed
reaction is logged and never undoes the change. Operator pause and resume don't react.

In one transaction under the monitor's advisory lock, so reactions to one monitor never interleave:

1. **Pages.** Each page with a component whose monitor-derived status the change moves (`suspect` and `recovering`
   don't) is marked dirty, and a [publish](#public-page) is requested.
2. **Incidents.** On `down`, a monitor without an open incident and with `incident_policy` other than `none` opens one
   on the page holding most of its components (first in page order on a tie): "<monitor> is down", `investigating`,
   `origin` `monitor` (`deploy_watch` during a [deploy watch](#the-deploy-watch)),
   severity `major` when a component goes to `major_outage` and `minor` otherwise, those components with their
   `impact_when_down`, and a link in `mocco_status_incident_monitors`. It is a `draft` unless the policy is `publish`
   and no maintenance window in progress covers one of the monitor's components; a draft never reaches the public
   page. While the monitor is open-linked: `recovering` posts a `monitoring` update, a failure while recovering posts
   `identified`, and `up` or `degraded` posts `resolved` and closes the link. An incident an operator resolved by hand
   closes its link at the next change, so the next outage opens a new one. Updates have no author.
3. **Audit.** After the commit, `status.incident.created` and `status.incident.updated` are appended with no actor,
   and a `monitorId` in the payload.
4. **Alerts.** One domain event per change ([events](./events.md)): `status.monitor.down` on `down`,
   `status.monitor.degraded` on `degraded`, and `status.monitor.recovered` on `up` after `down`, `recovering` or
   `degraded`. A false alarm (`suspect` to `up`), a first `up`, repeated verdicts and `unknown` rounds send nothing.
   The dedupe key is `<type>:<state change id>`, so a retried reaction publishes nothing new. The payload is a
   rendered message (title "Down: API health", the target, the previous state, whether an incident was opened, a
   link to the incident or the status console) with the facts `monitor`, `state` and `duringMaintenance`; during a
   window covering the monitor's components the title ends "(during maintenance)". Notification rules route them
   like any event; the `mocco` preset includes all three.

   The target ("Checks") is only the host and port: `api.acme.test:8443` for
   `https://user:pass@api.acme.test:8443/v1/health?token=…`, with the port left out when it is the scheme's default,
   and `host:port` for TCP (`monitorTargetOf` in `domain/status/monitor-target.ts`). URL credentials, path, query and
   fragment can hold secrets and everyone in a channel reads its alerts, so they never reach the message, the stored
   event or the activity trace. The incident a monitor opens names only the monitor, the audit payloads carry its
   name, kind and links but never its spec, and the public snapshot has no monitors. The full URL stays in the
   monitor editor.

A crash between the state change and its reaction loses the reaction (the same trade-off as other best-effort
events); a reconcile over unreacted state changes would close that gap.

### Time series and their partitions

`mocco_status_check_results` and `mocco_status_round_verdicts` are range-partitioned by UTC day on `round_at`, one
partition per day named `<table>_pYYYYMMDD` (`infra/db/day-partitions.ts`). drizzle-kit can't declare a partitioned
table, so a generated migration creates each table from `schema.ts` (0056, 0058) and a custom migration recreates it,
still empty, as the partitioned parent with the same columns, key, checks and index (0057, 0059). The drift check
still compares `schema.ts` to the snapshots, which don't record partitioning.

The `status.retention` job runs every hour (`TimeSeriesRetention`). For both tables it creates the partitions for
today and the next two days, and drops whole days past retention, so old rows go without a `DELETE`: 14 days of raw
results (`STATUS_RAW_RETENTION_DAYS`, 1 to 365, today included), 30 days of verdicts. Nothing reads a raw result after
its round closes, so the setting only bounds how long a round's per-location detail stays inspectable. State changes
are not partitioned and are kept. The same job deletes hourly rollups older than 90 days; that table is small (one row
per monitor and hour), so a `DELETE` on its `hour` index is enough and it isn't partitioned. If a result arrives for a day with no
partition yet (a fresh install before the job's first run), the insert creates that day's partition and retries once;
the evaluator creates the verdict partitions it needs before its transactions.

### Uptime rollups

The `status.rollup` job (`RollupService`, #152) turns the verdicts and state changes into the history that outlives
them: hourly rows from the round verdicts, and daily rows and component days from the hourly rows and the state
changes. Everything it writes is an upsert of a value computed from scratch, so rolling the same hour or day up again
gives the same rows, and dropping a day's raw or verdict partition never changes a daily row.

**Downtime is time, not rounds.** It comes from `mocco_status_monitor_state_changes`: a monitor is down from a change
to `down` until the next change to a state other than `down` or `recovering` (an outage runs until the next `up`), cut
at the hour or day boundary, so an outage across midnight counts on both days. Time between rounds is counted, and a
round with an `unknown` verdict (a location failure, every location silent) never changes the state, so it can't add
downtime. Before a monitor's first change it was in that change's `from_state`.

**Uptime** of a monitor's UTC day (`uptime.ts`):

```
uptime = 1 - (down - overlap_with_maintenance) / (observed - maintenance)
```

`observed` is the part of the day the monitor was watched: from the day's start, or the monitor's creation if later, to
the day's end, or now for the current day, without time spent `paused`. That is the design's `86400` for a whole
day. `maintenance` is the time a window covering one of the monitor's components actually ran (`actual_start` to
`actual_end`, or still in progress) inside the observed time, and `overlap_with_maintenance` the downtime inside it.
The ratio is rounded to six places; it is null when maintenance covered everything observed. A day before a monitor
existed has no row, so the history starts when tracking did.

**Hours.** Per monitor and hour: the closed rounds by verdict (`degraded` counts as `ok`: its checks passed, slowly),
the seconds down in the hour, and the rounds' latency (each round's median across locations, `p50_latency_ms`) as a
sum, a count and a histogram. An hour gets a row when the monitor had a round or downtime in it.

**Latency histograms** (`latency-hist.ts`) have 16 fixed buckets with doubling bounds: below 8 ms, 8 to 16 ms, and so on
up to 131,072 ms, then one open bucket. Every histogram has the same buckets, so a day's is the sum of its hours', and a
percentile read from any sum (interpolated inside its bucket) is within a factor of two; the daily row keeps `p95_ms`.

**Days.** Per monitor: the day's rounds and ok rounds (summed from its hours), `down_seconds`,
`maintenance_seconds`, `uptime_ratio`, the merged histogram and `p95_ms`. Per component (`mocco_status_component_days`,
from the day the component was created): `worst_status`, the worst of what its monitors put on it that day (the same
rule as [what a component shows](#what-a-component-shows)), the impacts of published incidents open some time that day,
and `maintenance` when a window covering it ran; `down_seconds`, the union of its monitors' downtime; `uptime_ratio`
with the formula above over that union and its own maintenance (null when no monitor reports on it); and
`incident_ids`, the published incidents open that day. Draft incidents never count, and a status set by hand has no
history yet, so it doesn't either.

**Schedule.** The job runs every ten minutes. Each run rolls up the hours that ended at least ten minutes ago and
aren't rolled up yet (24 at most, so a stopped job catches up on a day), then the current UTC day so far, then the
previous day again while the run is within two hours of 00:10. So a day is final from 00:10 UTC the next day, and late
rounds are still picked up until 02:10. Hourly rows are kept 90 days (deleted by `status.retention`), daily rows and
component days forever. Component days feed the public page's [90-day bars](#public-page), and a monitor's hours and
days are its `history` on the `status.monitor` read and on MCP.

## Audit

These changes are appended to the workspace's audit chain, after their transaction commits:

| Action | Subject |
|---|---|
| `status.page.created`, `status.page.deleted` | `status_page` |
| `status.component.status_changed` (from, to) | `status_component` |
| `status.incident.created`, `status.incident.updated` (from, to), `status.incident.components_changed`, `status.incident.postmortem_changed` | `status_incident` |
| `status.incident.run_linked`, `status.incident.run_unlinked` (`runId`, `relation`) | `status_incident` |
| `status.incident.created`, `status.incident.updated` for a monitor's incident (no actor, `monitorId` in the payload) | `status_incident` |
| `status.maintenance.scheduled`, `status.maintenance.canceled` | `status_maintenance` |
| `status.maintenance.started`, `status.maintenance.completed` (by the tick or a gated run, no actor), `status.maintenance.overran` (no actor) | `status_maintenance` |
| `status.gate_maintenance.set`, `status.gate_maintenance.deleted` | `status_gate_maintenance` |
| `status.monitor.created`, `status.monitor.updated`, `status.monitor.deleted`, `status.monitor.paused`, `status.monitor.resumed`, `status.monitor.heartbeat_token_rotated` | `status_monitor` |
| `status.location.created`, `status.location.token_rotated`, `status.location.disabled` | `status_location` |

Group and other component edits are not audited, and neither are the runs Mocco suggests for an incident.

A change made through the [`/v1` API](#the-v1-management-api) is recorded with the key's creator as the actor (none
once they're deleted) and `principal: "apikey:<key id>"` in the payload, so the log tells a script from a person. A
monitor made that way also has its `key` in `status.monitor.created` and `status.monitor.deleted`, and its state
changes say `by: "api_key"`.

## The /v1 management API

Monitors, incidents, maintenance and component statuses as code, for CI and scripts (#159):
`transport/ext/v1/status.ts`, mounted on the [public `/v1` API](./public-api.md#routes). Every route takes a secret key
of the project: reads need `status:read` and changes `status:write` (a publishable key is `403 wrong_key_kind`, a
missing scope `403 insufficient_scope`). The route only parses and maps errors; the same services as the console decide,
scoped by the key's workspace and project, so another project's or workspace's monitor, page, component, incident or
window is `404`, exactly like one that doesn't exist. Not-found errors are `404`; `IncidentTransitionError`, `MaintenanceTransitionError`, `MonitorKindError` and `MonitorPausedError` are `409 conflict`,
and `MaintenanceWindowError` and a body or query zod refuses are `400 bad_request`.

**Upsert by key.** `PUT /v1/monitors/by-key/{key}` takes the console's monitor input (`monitorInputSchema`) and makes the
project's monitor with that key match it. `MonitorService.upsertByKey` creates it (`201`, outcome `created`) when there
is none; otherwise it compares the stored settings, locations and components with the asked ones (ignoring key order in
`spec` and the order of the lists) and changes the monitor only if they differ (`200`, `updated`). An identical body is
`200 unchanged`: no write, no audit entry, the same answer as before, so a pipeline can run the same upsert on every
deploy. Switching between a heartbeat and a probe kind is `409`, as in the console. A new heartbeat's `mhb_` ping token
is in the `created` answer only (`heartbeatToken`, null otherwise). Two upserts of a new key racing both succeed: the
loser hits `mocco_status_monitors_project_key_uq` and updates the monitor the winner made. Keys are per project, so the
same key in another project is another monitor.

**What answers carry.** Each route builds its answer field by field from the service's rows, then parses it with its
`@mocco/common/status-v1` schema, which drops anything the schema doesn't list. A monitor's `target` is
`monitorTargetOf` (an HTTP URL's host and port, or a TCP host and port) and `check` holds only the method, the expected
statuses, the latency threshold, the timeout, redirects and the TLS warning, because a URL's credentials, path and query,
a request body and a keyword can hold secrets. No answer has a heartbeat token's hash, a location's token hash or a
workspace id.

| Route | Scope | Answer |
|---|---|---|
| `GET /v1/locations` | `status:read` | `{ locations: [{ id, code, name, kind, disabled }] }`: Mocco's shared locations and the workspace's own, for `locationIds` |
| `GET /v1/monitors` · `GET /v1/monitors/{id}` | `status:read` | `{ monitors: [Monitor] }` · `Monitor`: `id`, `key`, `name`, `kind`, `target`, `state`, `stateChangedAt`, `check` (null for a heartbeat), `heartbeat` (period, grace, last ping, last start, last duration; null for a probe kind), `intervalSeconds`, `confirmations`, `recoveryConfirmations`, `quorumMode`, `incidentPolicy`, `locationIds`, `components`, `createdAt`, `updatedAt` |
| `PUT /v1/monitors/by-key/{key}` | `status:write` | `{ outcome, monitor, heartbeatToken }`; `400` for a bad key or body, `404` for a location or component the project can't use |
| `POST /v1/monitors/{id}/pause` · `…/resume` | `status:write` | The monitor as it is now (pausing a paused one changes nothing) |
| `DELETE /v1/monitors/{id}` | `status:write` | `204` |
| `POST /v1/monitors/{id}/check` | `status:write` | An ad-hoc round ([the deploy watch](#the-deploy-watch)) |
| `GET /v1/pages` · `GET /v1/pages/{id}/components` | `status:read` | `{ pages: [{ id, slug, title, createdAt, updatedAt }] }` · `{ components: [{ id, pageId, groupId, name, description, position, status, displayedStatus, updatedAt }] }` |
| `PATCH /v1/components/{id}` | `status:write` | Body `{ status }`: the status set by hand (`setComponentStatus`); answers the component with its `displayedStatus` |
| `GET /v1/incidents?pageId=&open=` · `GET /v1/incidents/{id}` | `status:read` | `{ incidents: [Incident] }` (newest first, drafts included; `open=true` leaves out resolved ones) · `{ incident, updates: [{ id, status, body, createdAt }], components: [{ componentId, impact }] }` |
| `POST /v1/incidents` | `status:write` | Body `incidentCreateInputSchema` (`pageId`, `title`, `severity`, `status`, `body`, `components`); `201` with the incident as `GET` reads it. A published incident with `origin: manual` |
| `POST /v1/incidents/{id}/updates` | `status:write` | Body `{ status, body }`; `201 { incident, update }`; `409` for a step the lifecycle doesn't allow |
| `PUT /v1/incidents/{id}/components` | `status:write` | Body `{ components }`, replacing them; the incident as `GET` reads it |
| `GET /v1/maintenances?pageId=` | `status:read` | `{ maintenances: [{ id, pageId, title, body, status, scheduledStart, scheduledEnd, actualStart, actualEnd, componentIds, createdAt, updatedAt }] }` |
| `POST /v1/maintenances` · `POST /v1/maintenances/{id}/cancel` | `status:write` | Body as `maintenanceInputSchema` with ISO 8601 times; `201` · the window, `409` once it completed or was canceled |
| `GET /v1/status/openapi.json` | none | The OpenAPI 3.1 description |

**OpenAPI.** `transport/ext/v1/status-openapi.ts` lists the operations above (with `x-mocco-scope`) and generates
their request and answer schemas with `z.toJSONSchema` from the same zod schemas the routes parse with. It is served at
`GET /v1/status/openapi.json` (no key, the anonymous per-address limit, cached five minutes) with the base the request
came in on as its server. `status-openapi.test.ts` fails if a mounted status route is missing from it or it lists one
that isn't mounted, and validates real answers from the routes against its schemas.

**The SDK.** `@mocco/node`'s `createMoccoServer({ secretKey })` has `status`, a `StatusClient` from `@mocco/sdk-core/status`
([SDK packages](./sdk.md)): `status.monitors` (`list`, `get`, `upsert(key, input)`, `pause`, `resume`, `delete`,
`check`), `status.incidents` (`list(pageId, { open })`, `get`, `create`, `update(id, { status, body })`,
`setComponents`), `status.maintenances` (`list`, `schedule`, which takes `Date`s or ISO strings, and `cancel`),
`status.pages.list`, `status.components` (`list(pageId)`, `setStatus`) and `status.locations` (`list`, and
`idsOf(codes)`, which turns location codes into `locationIds`, preferring the workspace's own location over a shared
one with the same code and throwing for an unknown or disabled code). Methods resolve with the route's answer (lists
unwrapped) and throw `MoccoError` with the problem's `code` for a refusal. Reads and the upsert are retried on 429 and
5xx; other changes aren't. Its wire types are written out in `sdk-core/src/status.ts`, and `sdk-contract.test.ts`
checks them against the `@mocco/common/status-v1` schemas; `status-sdk.test.ts` runs it against the real `/v1` app on
pglite.

```ts
import { createMoccoServer } from '@mocco/node';

const mocco = createMoccoServer({ secretKey: process.env.MOCCO_SECRET_KEY! });
await mocco.status.monitors.upsert('api-health', {
  name: 'API health',
  spec: { kind: 'http', url: 'https://api.acme.com/health', expectedStatus: [200] },
  locationIds: await mocco.status.locations.idsOf(['office-network']),
});
```

## tRPC

`status.*` is built on `productProcedure(Products.status)`: the caller must be a member of `workspaceId`,
`projectId` must belong to it, and the status product must be enabled (`FORBIDDEN` otherwise). The same procedure
maps the domain's errors: `StatusEntityNotFoundError` is `NOT_FOUND`; `StatusPageSlugTakenError`,
`IncidentTransitionError`, `MaintenanceTransitionError`, `LocationCodeTakenError` and `MonitorKindError` are `CONFLICT`; `MaintenanceWindowError` is
`BAD_REQUEST`. Every lookup is scoped by workspace and project, so another tenant's ids are `NOT_FOUND`. A test
calls every procedure as a non-member and with another tenant's ids, and fails if a procedure is missing from it.

| Procedures | Purpose |
|---|---|
| `pages`, `page`, `createPage`, `updatePage`, `deletePage` | Pages; `page` returns groups and components with `displayedStatus` |
| `createGroup`, `updateGroup`, `deleteGroup` | Groups |
| `createComponent`, `updateComponent`, `setComponentStatus`, `deleteComponent` | Components; `setComponentStatus` is audited |
| `incidents`, `incident`, `createIncident`, `postIncidentUpdate`, `setIncidentComponents`, `setPostmortem` | Incidents; `incident` returns the timeline and affected components |
| `incidentRuns`, `correlateIncident`, `linkRun`, `unlinkRun` | The runs linked to an incident ([deploy correlation](#deploy-correlation)); `linkRun` takes `relation` `manual` or `fix` |
| `runIncidents` | The incidents a run is linked to (`workspaceId`, `runId`; membership and the status product, no `projectId`), for the run's page. It lives here so the execution router never depends on status; another workspace's run is `NOT_FOUND` |
| `maintenances`, `scheduleMaintenance`, `cancelMaintenance` | Maintenance |
| `gateMaintenances`, `setGateMaintenance`, `deleteGateMaintenance` | The page's gates that announce maintenance ([maintenance from gated runs](#maintenance-from-gated-runs)); `maintenances` returns `runId`, `gateId`, `overranAt` and `endNote` with each window |
| `monitors`, `monitor`, `createMonitor`, `updateMonitor`, `pauseMonitor`, `resumeMonitor`, `deleteMonitor`, `rotateHeartbeatToken` | Monitors (never a heartbeat token's hash); `createMonitor` answers `{ monitor, heartbeatToken }` (null for a probe kind) and `rotateHeartbeatToken` `{ monitor, token }`, the only times a ping token is shown; `monitor` returns its location ids, components, latest state changes (50, newest first), latest ten closed rounds (newest first), the incident it opened that is still open (`openIncident`, or null), and `history`: its rolled-up `hours` (the last 48) and `days` (the last 90), oldest first, each with `rounds`, `downSeconds`, and `p50Ms` / `p95Ms` read from the latency histogram (days add `uptimeRatio`); rows the rollup hasn't written are absent |
| `locations`, `createLocation`, `rotateLocationToken`, `disableLocation` | Probe locations of the workspace (no `projectId`); the writes need an owner or admin (`FORBIDDEN` for a plain member), and `.output()` strips `token_hash`, so a token appears only in `createLocation` and `rotateLocationToken` |

Agents read the same data over MCP ([ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)); see
[MCP](#mcp) below. A mutating tool for posting an incident update, behind the workspace's switch, comes later.

## Not built yet

An `api` incident origin, and changing an incident's title or severity through `/v1`; hosted
locations, publishing `@mocco/probe` to npm and its image to
GHCR, the `hb.mocco.club` ping host (and a ping URL on the public API host in the console), a heartbeat that goes down when a
`/start` isn't followed by a finish within a time limit, a location-unhealthy
alert, a per-component `status_source` switch, TLS expiry warnings, and a reconcile of state changes whose reaction was
lost; page `visibility`, `locale` and `theme`; the CDN host mapping
(`<slug>.status.mocco.club`) and custom domains; subscribers; a way to publish a draft incident
(a monitor's draft is visible in the console but can't be published yet); repo and project links on components;
`origin` and `suspected_run_id` in the console and the incident DTO; `tlsWarnDays` in the monitor form; a
latency chart in the console's monitor view (the series is `history` on `status.monitor`); and gate-linked maintenance
in the console (the gate maintenance form, and a window's run, overrun and end note), in the `/v1` maintenance answers and on
MCP, plus a per-window `suppress_alerts` switch. Each arrives with its slice as an additive column or table.

## MCP

Agents read status pages over MCP with `mocco_status_pages_get` (each component and its `displayedStatus`),
`mocco_status_incidents_search` (open by default; by status, severity, page or title text, newest first, paged),
`mocco_status_incidents_get` (the timeline, affected components and postmortem; detailed adds the linked deploys from
`CorrelationService.list`: relation, score, repo, commit, when the run finished, and whether Mocco suggested it or a
person linked it) and `mocco_status_maintenances_search` (scheduled and in progress by default) in
`transport/mcp/tools/status.ts`: thin, read-only adapters over `getPage`, `IncidentService.list` / `get` and
`MaintenanceService.list`, behind the same checks as `productProcedure(Products.status)` (`ProjectScope`). A page is
looked up among the project's own, so another tenant's page or incident reads like one that does not exist.

Monitors and locations are in `transport/mcp/tools/status-monitors.ts`. `mocco_status_monitors_search` reads
`MonitorService.list` (by name, paged with `after`; filtered by `states` and name text) and
`mocco_status_monitors_get` reads `MonitorService.get` (the latest state changes, newest first, capped by `limit`; the
open monitor incident; detailed adds each change's `reason` (with a heartbeat's `cause` and `exitCode`), the latest
closed rounds and the same `history` as `status.monitor`: uptime and p50/p95 latency for the last 48 hours and 90 days,
and for a heartbeat its period, grace, last ping, last start and last duration instead of the probe settings), both
behind `ProjectScope`.
A monitor's `target` is `monitorTargetOf`, the same host and port alerts show: its URL credentials, path and query, its
request body and its keyword never leave the server, because they can hold secrets. `mocco_status_locations_search`
reads `LocationService.list` behind the checks of the workspace-level `locations` query (membership and the status
product, `ProjectScope.resolveWorkspace`), which any member may read; it never returns a token hash. Nothing on MCP
declares or updates an incident, or changes a monitor or a location. See
[Connect Mocco to your agent](../customer/mcp/connect.md).
