---
title: Background jobs and schedules
description: How to add a job handler, enqueue work, and schedule it; retries, RetryAt, dedupe, the tick route and its env vars, and how hosted and self-host deploys drive it.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, jobs, scheduler, queue, backend]
related:
  - ../adr/0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
  - ./backend-conventions.md
  - ./env.md
code_refs:
  - packages/backend/src/domain/jobs/JobRunner.ts
  - packages/backend/src/domain/jobs/PostgresJobQueue.ts
  - packages/backend/src/domain/jobs/policy.ts
  - packages/backend/src/domain/jobs/repos/job.repo.ts
  - packages/backend/src/domain/jobs/repos/job-schedule.repo.ts
  - packages/backend/src/transport/ext/jobs.ts
  - packages/frontend/vercel.json
---

# Background jobs and schedules

Background work is a row in `mocco_jobs`. `JobRunner.tick` claims due rows and runs their
handlers; Vercel Cron, a self-host cron or `curl` calls the tick every minute. The decision and the
alternatives are in [ADR 0014](../adr/0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md).

## Adding a handler

A job is a kind plus a zod payload schema. Define it once in the owning domain and export it, so
enqueuers and the handler share the same schema:

```ts
// domain/notification/jobs.ts
export const deliverNotification = defineJob('notification.deliver', z.object({ deliveryId: z.uuid() }));

export function createDeliverHandler(service: NotificationService) {
  return handleJob(deliverNotification, async (payload, ctx) => {
    await service.deliver(payload.deliveryId, ctx.attempt);
  });
}
```

Register the handler in `domain/jobs/instance.ts` (`handlers: [createPruneHandler(jobs), …]`).
Kinds are `<domain>.<verb>`; keep them in an `as const` object in the domain. Two handlers for one
kind throw at startup.

Handlers must be **idempotent**: a crashed or timed-out run is retried. `ctx` carries `jobId`,
`kind`, `attempt` (1 on the first try), `workspaceId` and `now()`.

## Enqueueing

Domains depend on the `JobQueue` port (`domain/jobs/ports.ts`), injected by their composition root:

```ts
await queue.enqueue(deliverNotification, { deliveryId }, { workspaceId, kick: true });
```

| Option | Meaning |
|---|---|
| `runAt` | Earliest run time. Default now. |
| `dedupeKey` | While a job with the same kind and key is `queued` or `running`, `enqueue` returns that job (`created: false`) instead of inserting. Finished jobs don't block a new one. |
| `maxAttempts` | Default 8. |
| `workspaceId` | The tenant. The job is deleted with the workspace. |
| `kick` | Also run the job right away in `waitUntil`. The table is the fallback if that run dies. Deduped enqueues are not kicked. |

The payload is parsed with the job's schema at enqueue; a mismatch throws (it is a programming
error, not a job failure).

## Lifecycle, retries and dead jobs

`queued` → claimed (`running`, `attempts + 1`, `locked_until = now + 5 min`) → one of:

- **Success** → `succeeded`.
- **Throw** → back to `queued` with `run_at = now + min(2^attempts × 15s, 6h)` plus up to 25%
  jitter and `last_error` set. When `attempts` reaches `max_attempts` → `dead`.
- **Payload fails its schema** → `dead` at once, no retries.
- **Unknown kind** (e.g. an older runner during a deploy) → a normal failure, retried.
- **The runner dies** → `reclaimExpired` (every tick) re-queues it once `locked_until` passes; the
  crashed attempt stays counted, and a job with no attempts left goes `dead`.

Every write after a claim checks the claim's lock token (`locked_by`), so a runner that lost its
lock cannot overwrite the next runner's result (its outcome is reported as `lost`).

`jobs.prune` runs daily as a platform schedule: it deletes `succeeded` jobs finished more than
7 days ago and `dead` jobs finished more than 30 days ago. `failed` is allowed by the status
check (platform design §7) but nothing writes it today.

## RetryAt: retry at a specific time

When a handler knows when to try again (a rate limit's `retry_after`), it throws `RetryAt`
instead of an ordinary error:

```ts
throw new RetryAt(new Date(Date.now() + retryAfterMs), 'discord rate limit');
```

The job goes back to `queued` with `run_at` at that time (a time in the past means now) and
`last_error` set to the reason. It **does not spend an attempt** for up to five RetryAts in a row
(`JobPolicy.maxConsecutiveDeferrals`, tracked in `mocco_jobs.deferrals`). Past five, each further
RetryAt counts as an attempt, so a handler that always asks for "later" still ends `dead` after
`max_attempts`. Any other outcome resets the count.

## Schedules

`mocco_job_schedules` rows enqueue a job per slot. Only `interval_seconds` is evaluated today; the
`cron` column is reserved (no parser dependency yet) and the tick disables a cron row it finds.

- Each tick picks due, enabled schedules with `FOR UPDATE SKIP LOCKED`, inserts a job with
  `dedupe_key = <scheduleId>:<slot ISO time>`, and moves `next_run_at` to the first slot after
  now. Missed slots are skipped, not replayed.
- Two overlapping ticks never enqueue the same slot twice: the row lock keeps them apart, and the
  dedupe key makes a replayed slot a no-op.
- Tenant schedules are created with `JobScheduleRepo.create({ kind, payload, intervalSeconds,
  nextRunAt, workspaceId, projectId })`. Platform schedules (no workspace, one per kind) are listed
  in the runner's `systemSchedules` and ensured at the start of every tick.
- High-frequency per-entity work (status checks every 60 s for thousands of monitors) should keep
  its own due column and register one dispatch schedule, not a schedule row per entity.

## The tick

`JobRunner.tick({ budgetMs, maxJobs })`: ensure platform schedules → reclaim expired locks →
enqueue due schedule slots → run due jobs one at a time until `budgetMs` has passed or `maxJobs`
ran. It never runs a job twice in one tick. Unreached jobs stay queued.

Route: `GET` or `POST /api/ext/internal/jobs/tick` with `Authorization: Bearer <secret>`.

| Response | When |
|---|---|
| `503` | Neither `CRON_SECRET` nor `JOBS_TICK_SECRET` is set. |
| `401` | Missing or wrong bearer. Nothing runs. |
| `200` | The tick ran. Body: `{ reclaimed, scheduled, ran, outcomes: { succeeded, retried, deferred, dead, lost } }`. |

### Env

| Var | Default | Meaning |
|---|---|---|
| `CRON_SECRET` | unset | Vercel Cron sends it as the bearer when the project has it set. |
| `JOBS_TICK_SECRET` | unset | Our alias for self-host callers. Either secret is accepted. |
| `JOBS_TICK_BUDGET_MS` | `50000` | How long a tick keeps claiming jobs. Keep it below the function's max duration. |

### Hosted (Vercel)

`packages/frontend/vercel.json` schedules the tick every minute (`* * * * *`). Vercel Cron sends a
`GET` to the production deployment with the `CRON_SECRET` bearer; set `CRON_SECRET` in the
project. Cron delivery is best effort and can occasionally repeat, which the queue tolerates.

**Hobby plan:** Vercel allows only daily crons on Hobby, and a per-minute expression fails the
deployment. On Hobby, remove the `crons` entry and point an external pinger (any uptime or cron
service) at the tick with `JOBS_TICK_SECRET`; kicked jobs still run immediately.

### Self-host

Set `JOBS_TICK_SECRET` and call the tick every minute from any cron:

```sh
* * * * * curl -fsS -H "Authorization: Bearer $JOBS_TICK_SECRET" https://mocco.example.com/api/ext/internal/jobs/tick
```

A `yarn worker` loop (and a docker-compose worker service) is planned but not built yet.

## Testing

Repos, runner and route tests run on pglite with an injected clock (`now: () => Date`), `random`
and `waitUntil`; no module mocks. pglite is a single connection and serializes transactions, so
the claim test proves that interleaved claims never share a job; the true two-connection race is
covered by `FOR UPDATE SKIP LOCKED` on real Postgres.
