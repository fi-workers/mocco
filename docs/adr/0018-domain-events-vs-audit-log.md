---
title: Domain events are separate from the audit log
description: Integration between domains goes through mocco_domain_events, a pruned, typed event table fanned out to subscribers by the job queue; the hash-chained audit log stays the compliance record and run events stay the run timeline.
type: adr
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
decision_date: 2026-09-25
stakeholders: [andrea]
tags: [adr, platform, events, audit, notifications]
related:
  - ../reference/events.md
  - ../reference/jobs.md
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
---

# ADR 0018 — Domain events are separate from the audit log

## Context

Products after deploy governance need to react to what Mocco already knows: notifications on a
pending gate, feedback marking suggestions shipped on a release, status pages correlating incidents
with deploys. Mocco already has two append-only logs:

- **`mocco_audit_log`** — a per-workspace hash chain of governance decisions, kept forever, verified
  by re-walking it. It is compliance evidence.
- **`mocco_run_events`** — one run's progression, read by the run timeline.

Either could be reused as an integration feed. Reusing the audit log would mix convenience traffic
into a record whose value is that it is complete and tamper-evident, and nothing could ever be
pruned. Reusing run events would tie every consumer to the execution domain's internal vocabulary
(`step.dispatched`, …) and leave products without a place for their own events.

## Decision

1. **A third table, `mocco_domain_events`**, holds facts published for other domains: `type`,
   `subject_type`/`subject_id`, a JSON `payload`, `workspace_id`, optional `project_id`,
   `occurred_at`, and a global `seq`. Rows are pruned after 30 days by the daily `events.prune`
   job.
2. **A typed catalog.** Every type is declared in `@mocco/common/events` with one zod payload
   schema. `EventBus.publish` parses the payload against it and throws on a mismatch, so
   subscribers can trust the shape. Other areas (inbound sources, products) extend the catalog.
3. **Fan-out through the job queue (ADR 0014).** Publishing stores the row and enqueues one
   `events.deliver` job per matching subscriber (`dedupe_key = <eventId>:<subscriber>`, kicked).
   Subscribers match an exact type or a `prefix.*` wildcard and are registered at composition under
   stable names. Delivery is at-least-once; a ledger (`mocco_domain_event_deliveries`) keeps a
   second job for the same pair from calling the subscriber again.
4. **Publishers may be idempotent.** An optional `dedupe_key`, unique per workspace, makes a repeat
   publish (a redelivered inbound webhook, a governance transition reached twice) return the first
   event; its deliveries are enqueued again, which the job dedupe and the ledger make no-ops, so a
   retry also repairs a fan-out lost between the insert and the enqueue.
5. **Governance publishes after the state change, best-effort.** `RunService` and `GateService`
   publish `run.succeeded`, `run.failed`, `gate.pending`, `gate.resumed` and `gate.rejected` after
   the run or gate is written. A failed publish is logged and never rolls back or fails the
   governance action: notifications are convenience, not correctness. (The foundations design
   said "fail-closed with a logged error"; the governance state is what must not fail, so the
   publish is the part that gives way.)
6. **The audit log is unchanged.** Governance decisions keep being recorded there; a domain event
   never replaces an audit entry, and pruning events never touches the audit log.

## Alternatives considered

- **Subscribe to the audit log.** No retention, and every convenience consumer would read the
  compliance record. Rejected.
- **Subscribe to run events.** Execution-internal vocabulary, run-scoped, and no room for other
  domains' events. Rejected.
- **Publish inside the state change's transaction (an outbox).** Atomic, but services write through
  repos without a shared transaction today. Deferred: a later refactor can pass a transaction
  handle into the repos (the pattern `AuditRepo.appendChained` already uses) and enqueue with
  `executor: tx`.
- **In-process callbacks instead of jobs.** Lost when the function dies, no retries. Rejected.

## Consequences

- A crash between a state change and its publish loses that event. Consumers where loss matters
  (the release registry) must also reconcile on a schedule.
- Every subscriber is idempotent, and its name is permanent once events have been delivered under
  it (renaming it re-delivers nothing and orphans the old ledger rows until they are pruned).
- The subscriber list must be the same in every process: the publishing lambda decides whom to
  enqueue for, and the tick finds the handler by name. It lives in one pure function.
- `deploy.released` and the release registry (`mocco_releases`) are defined in the foundations
  design (§15: a run that succeeded and passed at least one resumed gate, per project linked to the
  run's repo) and land in their own slice, as a subscriber of these events.
