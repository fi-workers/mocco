---
title: Approvals outside pipeline runs
description: Product changes that are not pipeline runs (OTA promotions, raised minimum versions, flag changesets) are decided by one ApprovalService with the same GateRequirements, voter guards and N-of-M evaluator as run gates; risk-removing changes apply at once and get a post-hoc review; a channel may opt in to accept a resumed run gate as its approval.
type: adr
status: draft
created: 2026-10-01
updated: 2026-10-01
confidence: high
owner: andrea
decision_date: 2026-10-01
stakeholders: [andrea]
tags: [adr, governance, approvals, ota, flags]
related:
  - ../reference/approvals.md
  - ../specs/2026-09-24-ota-design.md
  - ../specs/2026-09-25-ota-release-control-design.md
  - ./0003-core-model-is-pause-resume-gates-no-env.md
---

# ADR 0020 — Approvals outside pipeline runs

## Context

Gates (ADR 0003) decide whether a paused pipeline run may continue. OTA promotions to protected channels, raised minimum app versions, and later feature-flag changesets need the same decision, but they are not steps of a run: a person or a CI job asks for a specific change, and someone else must approve it. Building a second approval mechanism per product would let the rules drift (who may vote, distinct principals, self-approval, reasons) and would scatter the audit trail.

## Decision

1. **One `ApprovalService` in `domain/governance`** answers "may this pinned change happen?". A product opens a request with `{ subjectType, subjectId, action, requirements }`. `action` is the exact change, pinned in the row. `requirements` is a `GateRequirements` snapshot fixed at creation; a later policy edit supersedes pending requests and never rewrites them.
2. **The same rules as run gates.** The voter guards (`prevent_self`, holding a required role, `reason_required`) live in one pure module shared by `GateService` and `ApprovalService`, and the N-of-M decision is the existing `evaluateGate` with its distinct-principal matching. One vote per person.
3. **Two kinds.** A `pre_approval` gates a change: the product registers a handler per `subjectType` (`approvals.registerHandler`), and the handler applies the pinned action once the request is approved. A `review` records the post-hoc review of a change that was applied at once.
4. **Direction rules.** Changes that add risk (promote, raise a rollout, raise a version floor, weaken a policy) are gated. Changes that remove risk (pause, roll back, lower a floor) apply immediately, are always audited, and open a `review`, so operators never wait for an approver during an incident. Weakening a policy is gated under the *current* policy.
5. **Dependency direction.** Product domains import governance; governance never imports a product. The product binds its handler in its own composition root.
6. **A resumed run gate may count as the approval, opt-in per channel.** An OTA channel policy may declare `accept_run_gate: { pipeline, gate }`. A promotion made through an upload session that the credential broker minted for a run whose named gate was resumed is then applied directly, recorded with that `run_id` and no approval request. The run gate already applied the same requirements, voters and audit, so a second vote would only repeat it.

## Consequences

- Every governed product change, whether through a run or not, lands in one audit chain with the same approval semantics. The approvals reference documents the procedures.
- Products must express their changes as pinned, idempotent actions with an optimistic-concurrency check (for example a policy `revision`), because the handler may run long after the request.
- An unreviewed post-hoc change never blocks operations; it is a visible evidence gap the team can close.
- `accept_run_gate` couples a channel to a specific pipeline and gate name; renaming either in `.mocco.yml` stops direct promotion until the policy is updated, which fails closed.
