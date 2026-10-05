---
title: Release registry
description: What counts as a production release without environments, the mocco_releases table, the deploy.released event, and the reconcile job that fills rows the event path missed.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, releases, events, governance, project]
related:
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../adr/0018-domain-events-vs-audit-log.md
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./events.md
  - ./jobs.md
  - ./project.md
code_refs:
  - packages/backend/src/domain/project/ReleaseService.ts
  - packages/backend/src/domain/project/repos/release.repo.ts
  - packages/backend/src/domain/project/subscribers.ts
  - packages/backend/src/domain/project/jobs.ts
  - packages/backend/src/domain/project/compose.ts
  - packages/common/src/events.ts
---

# Release registry

The release registry records what shipped to production, per project. Products that need to
know about releases read it: feedback marks suggestions shipped, status pages show releases
around an incident, reviews match a version to a run. It is the run half of the registry in
[platform foundations](../specs/2026-09-24-platform-foundations-design.md) §4 and §15. OTA and
store releases will add their own sources later.

## What counts as a release

Mocco has no environments ([ADR 0003](../adr/0003-core-model-is-pause-resume-gates-no-env.md)).
Gates are what separate a production deploy from any other run. So **a release is a run that
succeeded and passed at least one resumed gate.** A run with no gate, a run that failed or was
rejected after its gate was resumed, and a canceled run are not releases.

A release is recorded for every project linked to the run's repo (`mocco_project_repos`) at
the time it is first recorded. That set doesn't change afterwards: a project linked later does
not inherit the repo's past releases. A run whose repo has no linked project records nothing
and publishes nothing.

A per-project `release_step` label (fire when a named step succeeds instead) is still an open
question in the design and is not built.

## `mocco_releases`

One row per (project, run), unique on `(project_id, run_id)`:

| Column | |
|---|---|
| `workspace_id`, `project_id` | composite FK to the project (cascade) |
| `run_id` | the released run; `SET NULL` if the run is deleted |
| `repo_id` | the run's repo; `SET NULL` if the repo is deleted |
| `commit_sha` | the commit the run deployed |
| `gates` | the resumed gates it passed, in pipeline order: `{ gateId, name, resumedBy: { userId, role }[] }[]` (`role` is null once the role is deleted) |
| `released_at` | when the run finished |

The row outlives its run and repo, so the commit and the people who resumed it stay on record
after a repo is disconnected.

`ReleaseService.listForProject(workspaceId, projectId, { limit, before })` reads a project's
releases, newest first. There is no tRPC, MCP or `/v1` surface yet. Status
[deploy correlation](./status.md#deploy-correlation) reads releases around an incident's start
(`ReleaseRepo.listReleasedBetween`) through its own port.

## How a release is recorded

The `release.record` subscriber listens to `run.succeeded` (registered in `createEventBus`).
`ReleaseService.recordRun`:

1. loads the run and returns if it is not `succeeded` or has no resumed gate;
2. lists the projects linked to its repo and returns if there are none;
3. inserts one row per project with `ON CONFLICT DO NOTHING`;
4. publishes `deploy.released` with the dedupe key `deploy.released:<runId>`.

Both writes are idempotent, so a redelivered `run.succeeded` (delivery is at-least-once) adds
no row and no second event. If the publish fails, the subscriber throws and its delivery job
retries; the rows already written stay. The run itself is never affected: `run.succeeded` is
published after the run is stored, best-effort ([events: publishing](./events.md#publishing)).

## `deploy.released`

One event per released run, subject `run` / run id. The payload is the run payload every
governance event carries (`workspaceId`, `runId`, `repoFullName`, `pipelineName`, `commitSha`,
`linkPath`, `triggeredByUserId`, `triggeredByName`, `facts`) plus:

- `repoId` and `projectIds` (every project a row was recorded for);
- `previousReleaseSha`: the commit of the repo's latest release before this one, or null. A
  consumer computes "what's in it" from the two commits;
- `gates` (as stored on the row) and `resumedBy`, everyone whose vote counted, once per person
  and role;
- `releasedAt` (ISO 8601).

`occurredAt` is the run's finish time, so a release published late by the reconcile job still
sorts and prunes by when it happened.

The notification fan-out subscribes to `deploy.*`, so a channel rule on `deploy.released` posts a
"Released: owner/name" message ([notifications: templates](./notifications.md#templates)). It is
not in the `mocco` preset; add the rule to a channel to get it.

## Reconciling

ADR 0018 accepts that a crash between a state change and its publish loses the event. The
registry must not lose releases, so `releases.reconcile` runs hourly as a platform schedule.
It looks at runs that finished in the last 7 days (`RELEASE_RECONCILE_WINDOW_MS`), succeeded,
passed a resumed gate and whose repo is linked to a project, and picks those with **no release
row** or **no `deploy.released` event**. It records them oldest first, at most 100 per run
(`RELEASE_RECONCILE_BATCH_SIZE`), through the same `recordRun`, so it never duplicates a row or
an event. A run that fails is logged and picked up again on the next pass.

The window is well inside the 30-day event retention, so a published event is still there to
be found. Pruning events (`events.prune`) never touches release rows or the audit log.
