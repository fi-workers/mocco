---
title: Slice 5 — Gates & approval (pause / resume)
description: A pipeline can contain gates; a run pauses at a gate and an authorized member resumes (=approves) it, with N-of-M AND role requirements, prevent_self, and reason_required. Roles↔members are managed in an Access surface. Enforcement is orchestration-level (the credential broker is still deferred). Resolves ADR-0013 (#74) for the gate aggregate: anemic services + a pure evaluator, not a rich DDD aggregate.
type: spec
status: active
created: 2026-07-27
owner: andrea
tags: [spec, slice, gates, approval, pause-resume, roles, access]
related:
  - ../../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../../adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md
  - ../../adr/0012-repository-per-table-for-db-owning-domains.md
  - ../../reference/feature-map.md
  - ./2026-07-12-e2b-governance-roadmap-design.md
  - ./2026-07-26-slice4-runs-execution-design.md
---

# Slice 5 — Gates & approval

## 1. Purpose & scope

Execution is Live: a commit candidate becomes a Run whose steps execute over a trigger→callback→advance loop (`RunService.applyCallback` is the single funnel). This slice adds the governance core (ADR 0003): a pipeline can declare **gates** between steps; a run **pauses** at a gate; an authorized member **resumes** (= approves) it under **N-of-M AND** role requirements, **prevent_self**, and **reason_required**. Roles↔members are managed in an **Access** surface.

**Enforcement is orchestration-level:** Mocco won't dispatch the gated step until the gate is resumed. It is fully effective for Mocco-triggered runs (the generic executor). The un-bypassable version (the credential broker) is still deferred — noted in the feature-map.

**In scope** (roadmap §5 "slice 4", taken as one slice, shipped as a 3-PR stack): roles + memberships + Access UI; `.mocco.yml` v2 gate schema; a pure gate evaluator; `run_gates`/`resumes`; run pause-at-gate + resume; `GateService`/`RoleService`; the gate card UI.

**Out of scope (deferred, ADR 0010 advanced):** the full `prevent_self` identity set (author/committer/gate-commit-author) — this slice uses the run's **triggerer** only; gate **expiry**; **preconditions** (require_merged_to / status checks / code-owner); **break-glass**; **finally**/finalizer; and the **credential broker** + `.mocco.yml` `credential` field. Audit (the hash chain) is its own later slice.

## 2. Key decisions

- **ADR-0013 (#74) resolved for gates → anemic services + a pure evaluator (functional core), NOT a rich DDD aggregate.** The gate is invariant-heavy (N-of-M bipartite matching, prevent_self, one-vote-per-person, legal transitions), which is exactly where a rich aggregate is usually argued for. But on this Drizzle (plain-row) + zod stack, the invariants land better as: a **pure `evaluateGate` function** (the N-of-M / bipartite logic, unit-tested — the SSOT), **DB constraints** (unique `(run_gate_id, user_id)` = one vote/person), and an **anemic `GateService`** (orchestration + prevent_self/role/reason policy). This keeps the ADR-0012 pattern and avoids the row↔entity↔DTO hydration cost. This closes #74 for the governance domain.
- **Scope = roles + gates together** (not Access-first), delivered as a 3-PR stack (§10).
- **`prevent_self` = the run's triggerer only** this slice; the fuller identity set (ADR 0010) is deferred (fail-closed note in §7).
- **N-of-M counts distinct principals via bipartite matching** (ADR 0010): one human fills at most one slot even across multiple required roles. This lives in the pure evaluator.

## 3. Architecture & data flow

```
trigger  → materialize step items → run_steps, gate items → run_gates (requirements snapshotted)
         → advance from item 0

applyCallback advance / trigger advance, at item i:
   item i is a STEP  → dispatch (as today)
   item i is a GATE  → run.state = awaiting_gate, run_gate[i].state = pending, emit gate.pending  (PAUSE — no dispatch)

GateService.resume(runId, gateIndex, user, decision, reason)
   · authorize member · gate is the run's current awaiting gate · prevent_self (triggerer) · role membership · reason_required
   · insert resume (unique per person) · evaluateGate(requirements, resumes, principals)
        → rejected  → run_gate.rejected, run.rejected (halt)
        → resumed   → run_gate.resumed, RunService resumes the run: advance PAST the gate → dispatch next item
        → pending   → wait for more votes
```

The gate pause/resume reuses the existing advance path; `GateService` calls a `RunService` method to resume a run from a satisfied gate (the executor loop is unchanged otherwise).

## 4. Data model

All: `mocco_` prefix, `uuid` PK, `workspace_id` direct scoping (cascade from workspaces), timestamps, service-layer enforcement. One migration.

- **`mocco_roles`** — `workspace_id`, `name`; uniq `(workspace_id, name)`.
- **`mocco_role_memberships`** — `workspace_id`, `role_id`→roles cascade, `user_id`→users cascade; uniq `(role_id, user_id)`.
- **`mocco_run_gates`** — `workspace_id`, `run_id`→runs cascade, `item_index` int, `name`, `state` CHECK (`pending|resumed|rejected|expired`), `requirements` jsonb (the `[{role,count}]` + `prevent_self`/`reason_required` snapshot at trigger), `resolved_at`; uniq `(run_id, item_index)`.
- **`mocco_resumes`** — `workspace_id`, `run_gate_id`→run_gates cascade, `run_id`, `user_id`→users **RESTRICT** (a vote's principal is never erased), `role_id`→roles, `decision` CHECK (`resume|reject`), `reason`; uniq `(run_gate_id, user_id)` — one vote/person/gate.
- **`mocco_runs.state`** CHECK gains `awaiting_gate`, `rejected`.

## 5. `.mocco.yml` v2 gate schema (ADR 0010)

`moccoConfigSchema` becomes `z.discriminatedUnion('version', [v1Schema, v2Schema])`. v1 (current: `{version:1, pipeline, steps:[{run,executor,with?}]}`) keeps working unchanged. v2: `{version:2, pipeline, steps:[item]}` where `item = z.discriminatedUnion('kind', [stepItem, gateItem])`:
- `stepItem` = `{kind:'step', run, executor, with?}`
- `gateItem` = `{kind:'gate', name, resume:[{role, count}], prevent_self?:boolean, reason_required?:boolean}`

Uniqueness moves to an **effective id** (`id ?? run ?? name`) — the current `run`-based duplicate check breaks on gates (no `run`). `mocco.schema.json` is regenerated (drift-checked). The parser (`MoccoConfigParser`) validates v1 or v2; a v2 run materializes both `run_steps` (step items) and `run_gates` (gate items) by `item_index`.

## 6. Pure evaluator

`evaluateGate(requirements, resumes, ctx)` → `'pending' | 'resumed' | 'rejected'` (pure, unit-tested — the ADR-0013 SSOT):
- Any `reject` vote → `rejected`.
- Otherwise **N-of-M AND via distinct-principal bipartite matching**: model required `(role, count)` slots vs the set of resume votes `(user, role)`; a maximum matching where each user fills at most one slot must satisfy every role's `count`. If satisfied → `resumed`, else `pending`.
- The evaluator is fed only *valid* votes (the service has already rejected prevent_self / non-member votes before recording).

## 7. Services

- **`RoleService`** (anemic) — `create`/`list`/`delete` roles; `addMember`/`removeMember`/`listMembers`. `mocco_roles`/`mocco_role_memberships` via repos (ADR 0012), workspace-scoped.
- **`GateService.resume(workspaceId, runId, gateIndex, userId, decision, reason)`** — authorize member; load the run + its current `awaiting_gate` gate (reject if the gate isn't the run's current one); **prevent_self**: if `requirements.prevent_self` and `userId === run.triggeredByUserId` → reject (deferred: the fuller identity set; **fail closed** — when an identity can't be determined, deny); **role membership**: the user must belong to a role named in `requirements.resume` (resolve `role_id`); **reason_required**: reject a missing reason; insert the resume (unique — a second vote by the same person is rejected); re-`evaluateGate`; on `resumed` → gate `resumed` + `RunService.resumeFromGate(run, gateIndex)` (advance past the gate, dispatch the next item); on `rejected` → gate `rejected` + run `rejected`.
- **`RunService`** gains: gate-aware materialization at `trigger`; advance pauses at a gate item (`awaiting_gate`) instead of dispatching; `resumeFromGate` continues the run. `applyCallback` is otherwise unchanged.

Anemic throughout: repos own data, services own policy, the pure evaluator owns the N-of-M invariant.

## 8. API surface

- `role` tRPC router — `create` / `list` / `delete` / `addMember` / `removeMember` / `listMembers` (workspace-scoped, `.output` zod).
- `run.resumeGate` mutation — `{workspaceId, runId, gateIndex, decision, reason?}`; maps `GateService` domain errors (not-member/foreign → NOT_FOUND, prevent_self/duplicate-vote/missing-reason → BAD_REQUEST/FORBIDDEN).
- `run.get` / `run.events` extend to include gate state (for the gate card). DTOs (`roleSchema`, `runGateSchema`, `resumeSchema`) in `@mocco/common`.

## 9. Frontend

- **Access page** (`/workspaces/[id]/access`) — roles list, create/delete, and member assignment per role.
- **Gate card** on the run timeline — shows the gate's requirements and progress (which roles still need votes), Approve/Reject buttons with a reason field, disabled with a hint when the viewer isn't eligible (prevent_self / not in a required role / already voted). Reuses the run page's silent polling (spinner only on first load).

## 10. Stacked PRs

1. **Access** — `roles`/`role_memberships` migration + repos + `RoleService` + `role` tRPC + Access UI. Independently shippable.
2. **v2 schema + evaluator** — `moccoConfigSchema` version discriminated-union widening (v2 gate item, effective-id uniqueness) + regenerated `mocco.schema.json` + the pure `evaluateGate` + its unit tests + `@mocco/common` gate DTOs. Pure/isolated — no run integration yet.
3. **Integration** — `run_gates`/`resumes` migration + gate-aware materialization + pause-at-gate in advance + `GateService.resume` + `RunService.resumeFromGate` + `run.resumeGate` tRPC + the gate card UI.

## 11. Deferred & open

**Deferred (ADR 0010):** full `prevent_self` identity set (author/committer/gate-commit-author); gate `expiry` → auto-reject; preconditions (require_merged_to / status checks / code-owner); break-glass; `finally`/finalizer; the credential broker + `.mocco.yml` `credential`. Audit hash chain is its own slice.

**Open (non-blocking):**
- Whether a `reject` should hard-fail the run (`rejected`, halt) or allow re-open — this slice halts (`rejected`), matching ADR 0010's "terminal outcomes are declared."
- Role deletion while a run pins it in `requirements` — the snapshot in `run_gates.requirements` is by name, so deleting a role doesn't corrupt an in-flight gate's record; resume then can't be satisfied for that role → the gate stalls (fail-closed). Acceptable for this slice; revisit with expiry.
