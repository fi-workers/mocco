---
title: Background jobs on a Postgres job table driven by a tick
description: Durable background work and schedules live in mocco_jobs and mocco_job_schedules; one tick entry point claims due rows with FOR UPDATE SKIP LOCKED and is driven by Vercel Cron, a self-host cron or curl, with a waitUntil kick for immediate jobs.
type: adr
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
decision_date: 2026-09-25
stakeholders: [andrea]
tags: [adr, platform, jobs, scheduler, queue]
related:
  - ../reference/jobs.md
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ./0011-external-api-surface-architecture.md
  - ./0012-repository-per-table-for-db-owning-domains.md
---

# ADR 0014 — Background jobs on a Postgres job table driven by a tick

## Context

The next product slices need work that outlives a request: notification deliveries with retries,
status monitor dispatch, review polling, translation, pruning. Until now the only deferred work was
`waitUntil` after a webhook, which is lost if the function dies and cannot be retried or scheduled.

Mocco runs on Vercel functions (no long-lived process) and must also self-host with nothing but
Node and Postgres. Production reaches Postgres through Supabase's transaction pooler, so anything
that holds a session (session advisory locks, `LISTEN`) is unreliable. Tests run on pglite.

The options (platform foundations design, §7): an own job table plus a tick; pg-boss; graphile-worker;
Vercel Queues; Vercel Workflow; Inngest or Trigger.dev.

## Decision

1. **Jobs and schedules are Mocco tables.** `mocco_jobs` (kind, payload, status, run_at, attempts,
   max_attempts, lock, dedupe key, last error) and `mocco_job_schedules` (kind, payload,
   `interval_seconds` or `cron`, `next_run_at`) are drizzle-migrated like every other table.
2. **One entry point: `JobRunner.tick({ budgetMs, maxJobs })`.** It ensures platform schedules,
   reclaims expired locks, enqueues due schedule slots and runs due jobs one at a time until the
   budget or `maxJobs` runs out. Whatever it doesn't reach stays queued.
3. **Claiming is one transaction with row locks.** `SELECT … FOR UPDATE SKIP LOCKED` then
   `UPDATE … SET status = 'running', locked_until, attempts + 1`, owned by `JobRepo.claim`
   (ADR 0012). Row locks are transaction-scoped, so this works on the transaction pooler. Each
   claim gets a lock token, and every later write for that run checks it, so a runner that lost
   its lock cannot overwrite the next runner's result.
4. **Drivers call the tick over HTTP.** `GET|POST /api/ext/internal/jobs/tick` on the ext app
   (ADR 0011), authorized by `Authorization: Bearer` with `CRON_SECRET` (the name Vercel Cron
   uses) or `JOBS_TICK_SECRET` (ours, for self-host). Hosted, `vercel.json` schedules it every
   minute. Self-host, any cron or `curl` hits the same route.
5. **Immediate jobs are kicked.** `JobQueue.enqueue(job, payload, { kick: true })` also runs the
   job in `waitUntil`, so latency matches today's webhook path while the table is the durable
   fallback.
6. **Retries are part of the queue.** Exponential backoff `min(2^attempts × 15s, 6h)` plus jitter;
   `dead` after `max_attempts`; a payload that fails its zod schema goes `dead` without retries. A
   handler can throw `RetryAt(time)` to be retried at a specific time (a rate limit's
   `retry_after`); that does not spend an attempt for up to five times in a row.
7. **Domains depend on the `JobQueue` port**, not on Postgres. A hosted-queue driver can replace
   the implementation later without touching handlers.

## Alternatives considered

- **pg-boss.** Serverless-friendly and feature-complete, but it owns a `pgboss` schema with its own
  migrations outside drizzle and the `mocco_` prefix, and its behavior on the transaction pooler and
  pglite is unverified.
- **graphile-worker.** Needs a long-running worker; Vercel's Postgres World for Workflow builds on it
  and states it does not work on serverless.
- **Vercel Queues.** Good fan-out and retries, but beta and hosted-only; self-host would still call
  Vercel's API.
- **Vercel Workflow, Inngest, Trigger.dev.** Durable multi-step orchestration Mocco doesn't need yet;
  self-hosting them means running their servers. This is ADR 0005's reversal condition, kept open.

## Consequences

- Minute-level scheduling on Vercel needs the Pro plan. Hobby only allows daily crons, and a
  `* * * * *` entry fails deployment there; a Hobby deploy must remove the entry and use an
  external pinger instead.
- Throughput is bounded by one tick per minute plus kicks. Mocco's workloads are small idempotent
  units; high-frequency per-entity work (status checks every 60 s) keeps its own due column and
  registers one dispatch schedule instead of a row per entity.
- Handlers must be idempotent: a crashed or timed-out run is retried.
- The claim race itself is only exercised by real Postgres; pglite serializes transactions, so the
  tests prove that interleaved claims never share a job, not that two connections race correctly.
- Deferred to later slices: cron expressions (the column exists; evaluating it would add a parser
  dependency), the `yarn worker` loop for self-host, and the `jobs.dead` domain event.
