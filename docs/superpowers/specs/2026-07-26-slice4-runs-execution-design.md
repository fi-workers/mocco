---
title: Slice 4 — Runs & the generic-executor live loop (design)
description: First execution slice. A commit candidate becomes a Run pinned to that commit's .mocco.yml snapshot, executed step-by-step by a generic serverless executor over a trigger→callback→advance loop, with a live run timeline. Executor-agnostic (ADR 0004); zero external dependencies.
type: spec
status: active
created: 2026-07-26
owner: andrea
tags: [spec, slice, runs, execution, executor, pause-resume]
related:
  - ../../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../../adr/0011-external-api-surface-architecture.md
  - ../../adr/0012-repository-per-table-for-db-owning-domains.md
  - ../../reference/feature-map.md
  - ./2026-07-12-e2b-governance-roadmap-design.md
---

# Slice 4 — Runs & the generic-executor live loop

## 1. Purpose & scope

The observation slice is complete and Live: connect a GitHub repo → tenant-isolated commit sync (`mocco_commits`) → per-commit `.mocco.yml` snapshot (`mocco_commit_configs`) → a commit-detail page that renders the parsed pipeline steps from a pure DB read.

This slice makes a pipeline **run**. A commit candidate becomes a **Run** that executes its steps one at a time through a **generic serverless executor** over a neutral trigger → callback → advance loop, streamed to a **live run timeline**. It is the first slice of the execution/gates epic and the foundation every later slice (GitHub adapter, gates, audit, credential broker) attaches to.

**In scope:** the run data model, `RunService` (trigger / applyCallback / observe), a neutral executor interface, a generic executor (serverless function, simulated steps), the Hono `/api/ext/callback` inbound surface with a per-run token, and the frontend Run button + live timeline.

**Out of scope (later slices):** GitHub Actions adapter (slice 5), gates/roles/approval (slice 6), audit hash-chain (slice 7), credential broker / cloud STS (deferred). No `credential` field in `.mocco.yml` here.

## 2. Key decisions (from brainstorming)

- **Pipeline source = the commit's config snapshot.** A Run pins the commit and its `mocco_commit_configs` row (which already holds the parsed, validated `definition` and a content hash). There is **no separate `Pipeline`/`PipelineVersion` entity** — that model (the dropped `feat/pipeline-define-view` branch, and slice 1 of the older E2b roadmap) is superseded by the observation model. This is the one deliberate divergence from `2026-07-12-e2b-governance-roadmap-design.md` §5.
- **Slice boundary = the full minimal loop that actually runs** (not a read-only run model). Delivered as a stack of 3 reviewable PRs (§10), but the slice is only "done" when a run advances to completion on a deployed Vercel preview with zero external accounts.
- **Executor-agnostic core (ADR 0004).** The core speaks Run / Step / neutral `start()` + callback funnel. The generic executor is the first (and here only) adapter; the GitHub adapter reuses the **same** `applyCallback` funnel next slice.
- **Anemic domain model (ADR 0012).** Runs follow the existing pattern: repo-per-table (row = entity), service owns policy, tRPC narrows via `.output`. The rich-vs-anemic question (issue #74 / ADR-0013) is **deferred to the gates slice**, where invariant-heavy aggregates actually appear; runs here are state-machine-light and fit the anemic pattern.

## 3. Architecture & data flow

```
commit-detail [Run]  ──run.trigger──▶  RunService.trigger
    · guard: commit_config present && valid
    · materialize run_steps from commit_config.definition
    · mint per-run callback token (store sha-256)
    · executor.start(step[0], ctx)  ─trigger event─▶  generic executor (serverless fn)

generic executor: "runs" a bounded step (sleep + progress) ──POST /api/ext/callback──▶ applyCallback
                                                             (run_id, token, step_index, status)

applyCallback (single funnel; generic now, GitHub next slice)
    · verify token (sha-256) + run/step state
    · record run_event, update run_step status
    · advance: dispatch next step  |  finish run (succeeded/failed)

frontend run page ──run.events(sinceSeq)  poll──▶ live timeline
```

`applyCallback` is the single convergence point: the generic executor (this slice) and the GitHub adapter (next slice) both funnel through it, so the core never learns adapter words.

## 4. Data model

All tables: `mocco_` prefix, `uuid().primaryKey().defaultRandom()`, `workspace_id` for direct tenant scoping (cascade from `mocco_workspaces`), shared `createdAt`/`updatedAt`, service-layer enforcement (no RLS). One drizzle migration.

**`mocco_runs`**
- `id` uuid PK
- `workspace_id` → workspaces (cascade)
- `commit_id` → `mocco_commits` (cascade) — the candidate
- `commit_config_id` → `mocco_commit_configs` (**RESTRICT** — never orphan the pinned definition)
- `state` text CHECK (`queued | running | succeeded | failed | canceled`) — gate states (`awaiting_gate`, `rejected`) added in the gates slice
- `current_index` int — cursor into the definition's steps
- `callback_token_hash` text — sha-256 of the opaque per-run token; unique
- `triggered_by_user_id` → users (set null)
- `trigger_source` text (`manual` for this slice)
- `started_at` / `finished_at` timestamptz (nullable)
- timestamps
- indexes: `(workspace_id, state)`, `(commit_id)`, unique `(callback_token_hash)`

**`mocco_run_steps`**
- `id` uuid PK, `workspace_id`, `run_id` → runs (cascade)
- `step_index` int, `name` text, `executor` text, `with` jsonb
- `status` text CHECK (`pending | dispatched | running | succeeded | failed | skipped | canceled`)
- `handle` text (nullable) — opaque adapter handle (keeps adapter words out of core)
- `logs_url` text (nullable)
- timestamps; unique `(run_id, step_index)`

**`mocco_run_events`** — append-only progression log (drives the live view; the audit source in the audit slice)
- `seq` bigserial PK, `workspace_id`, `run_id` → runs (cascade)
- `type` text (`run.created | step.dispatched | step.running | step.succeeded | step.failed | run.succeeded | run.failed | run.canceled`)
- `payload` jsonb, `created_at`
- index `(run_id, seq)` for the `sinceSeq` poll

## 5. Backend

**Repos (ADR 0012, one per table):** `RunRepo`, `RunStepRepo`, `RunEventRepo` under `domain/execution/repos/`. Sole drizzle importers; every read/write scoped by `workspace_id`; `getOrThrow`/`expectOne` from `infra/db/rows`; throw `EntityNotFoundError`, mapped to domain errors at the service.

**`RunService`** (`domain/execution/RunService.ts`, constructor-injected):
- `trigger(workspaceId, commitId, userId)` → resolve the commit workspace-scoped (reuse `CommitRepo.getByIdInWorkspace`), load its `commit_config`. **Guard:** `present === true && valid === true`, else throw a domain error (`ConfigNotRunnableError`). Materialize `run_steps` from `commit_config.parsedJson` (the `MoccoConfig` definition), create the run (`queued`, `current_index: 0`), mint the callback token (return the plaintext once; store only sha-256), then dispatch step 0 via the executor. Dispatch runs in a deferred `waitUntil` pass (the `commit-sync` pattern) so the mutation returns fast.
- `applyCallback(token, { runId, stepIndex, status, logsUrl? })` — **the single funnel.** Verify the token (sha-256) against the run and that `stepIndex === current_index` and states are legal (idempotent on redelivery). Update the run_step, append a run_event, then **advance**: if more steps → dispatch next (`current_index++`); else finish the run (`succeeded`/`failed`). A failed step fails the run (no retry/skip logic this slice).
- `observe(workspaceId, runId, sinceSeq)` → run + steps + `run_events` where `seq > sinceSeq` (pure DB read, `.output`-narrowed).

**Executor interface** (`domain/execution/ports.ts`, neutral — no adapter words):
```
interface Executor {
  start(step: RunStepDispatch, ctx: DispatchContext): Promise<{ handle: string }>;
}
```
`DispatchContext` carries `runId`, `stepIndex`, `callbackUrl`, `callbackToken`. The **generic executor** (`domain/execution/executors/generic/provider.ts`) implements `start` by POSTing the trigger to a generic-executor serverless function; that function "runs" a bounded step (a short `sleep` + a `step.running` then `step.succeeded` callback) and posts to `/api/ext/callback`. Injected into `RunService` at the composition root; tests inject a `FakeExecutor`.

**Inbound surface (ADR 0011):** add a `POST /callback` route to the existing ext Hono app (`transport/ext`, already carrying the GitHub webhook). Body zod-parsed; **auth = the per-run opaque token**, sha-256-compared against `mocco_runs.callback_token_hash` (constant-time). Never exposed through tRPC. `onError` returns a generic status — no internal detail leaks (symmetric with the webhook route).

## 6. API surface

- `run.trigger` mutation — input `{ commitId }`, `.output({ run: runSchema })`. `assertMember` authorizes; dispatch authority (`allowed_to_deploy`) is deferred.
- `run.get` query — `{ runId }` → run + steps.
- `run.events` query — `{ runId, sinceSeq }` → `{ events, run }` for the live poll.
- ext: `POST /api/ext/callback` — token-authed, funnels to `applyCallback`.

All DTOs are zod schemas in `@mocco/common` (`runSchema`, `runStepSchema`, `runEventSchema`), types via `z.infer`.

## 7. Frontend

- **Run button** on the commit-detail page — enabled only when the commit-config is `present && valid` (disabled with a hint otherwise). On click: `run.trigger` (optimistic navigate to the run page).
- **Run page** (`/workspaces/[id]/runs/[runId]`) — a live timeline of steps with their status, driven by polling `run.events` with a `sinceSeq` cursor (React Query, stop polling once the run is terminal). Reuses the `pipeline-steps` renderer where it fits.

## 8. State machine

- Run: `queued → running → (succeeded | failed | canceled)`.
- Step: `pending → dispatched → running → (succeeded | failed | skipped | canceled)`.
- `current_index` advances only on a step reaching `succeeded`. A `failed` step → run `failed`. `canceled` is a manual stop (a `run.cancel` mutation may land in this slice if cheap; otherwise deferred).

## 9. Testing

pglite integration (no mocks; `FakeExecutor` injected):
- `trigger` materializes steps from the config definition and dispatches step 0.
- `trigger` on a commit whose config is absent/invalid is rejected (`ConfigNotRunnableError`).
- `applyCallback` advances step-by-step and finishes the run; a failed step fails the run.
- token verification: a callback with a wrong/absent token is rejected; a redelivered callback is idempotent (no double-advance).
- tenant isolation: a run/commit in another workspace is `NOT_FOUND`.
- `observe(sinceSeq)` returns only newer events.

## 10. Stacked PRs

1. **Data layer** — migration (`runs` / `run_steps` / `run_events`) + `RunRepo` / `RunStepRepo` / `RunEventRepo` + `@mocco/common` zod DTOs. Repo-level pglite tests.
2. **Trigger + read (visible)** — `RunService.trigger` (+ `ConfigNotRunnableError`), `run.trigger` / `run.get` / `run.events` tRPC, the commit-detail Run button, and the run page showing materialized steps (all `pending`). Deployable: a run can be created and viewed.
3. **The loop (running)** — the executor interface + generic executor fn + Hono `/api/ext/callback` + `applyCallback` advance loop + live-timeline polling. Deployable: a run advances to completion end-to-end.

## 11. Deferred & open

**Deferred:** GitHub Actions adapter; gates/roles/resume; audit hash-chain; credential broker + `.mocco.yml` `credential`; outbox+Cron executor reliability (this slice invokes the executor via `waitUntil` fetch — if hosted background-invocation reliability bites, add the ADR-0005 outbox drain later); concurrency modes; `run.cancel` if it doesn't fit slice-3 cheaply.

**Open (non-blocking):**
- Retry/skip semantics for a failed step — this slice fails the whole run; revisit with gates.
- Whether `run_events.seq` being a global bigserial (vs per-run ordinal) matters for the poll — global is simpler and fine for the `sinceSeq` cursor.
