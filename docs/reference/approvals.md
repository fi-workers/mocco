---
title: Approvals outside runs
description: How any domain asks for an N-of-M approval of a pinned change (or records a post-hoc review) with the same requirements, voter guards and evaluator as run gates.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, governance, approvals, audit]
related:
  - ../specs/2026-09-25-ota-release-control-design.md
  - ./project.md
code_refs:
  - packages/backend/src/domain/governance/ApprovalService.ts
  - packages/backend/src/domain/governance/vote-policy.ts
  - packages/backend/src/domain/governance/evaluate-gate.ts
  - packages/backend/src/transport/trpc/routers/approval.ts
  - packages/common/src/governance.ts
---

# Approvals outside runs

> A run gate pauses a pipeline until N-of-M roles resume it. Product changes that are not pipeline runs (an OTA promotion, a raised minimum app version, a flag changeset) need the same decision. `ApprovalService` gives every domain that decision with the same `GateRequirements`, the same voter guards, and the same N-of-M evaluator.

## Model

| Table | Notes |
|---|---|
| `mocco_approval_requests` | `kind` (`pre_approval` \| `review`), `subject_type` + `subject_id` (opaque to governance), `action` (the pinned change, jsonb), `requirements` (a `GateRequirements` snapshot), `requested_by_user_id` (SET NULL), `state`, `expires_at`, `resolved_at`. |
| `mocco_approval_votes` | One per `(request_id, user_id)`. `role_id` is the required role the vote counted under (SET NULL), `decision` (`approve` \| `reject`), `reason`. `user_id` is RESTRICT, like `mocco_resumes`. |

States: `pending` → `approved` \| `rejected` \| `expired` \| `superseded`. All transitions go through one conditional update (`WHERE state = 'pending'`), so under concurrent votes exactly one writer resolves a request.

## Kinds

- **`pre_approval`** gates a change. When it is approved, the handler for its `subject_type` runs **once** with the approved row. Handlers must be idempotent and apply exactly the pinned `action`. The owning product's composition root binds its handler with `registerHandler` (the dependency points product → governance, never the reverse). Voting on a `pre_approval` whose subject has no handler fails before anything is recorded, so a request can never be approved without a way to apply it.
- **`review`** records the post-hoc review of a change that was applied at once (a rollback, a pause, a relaxed version policy). Approving it runs no handler; it closes the evidence gap.

## Rules

- **Requirements are pinned** at creation. A later policy edit supersedes pending requests (`supersedePending`); it never rewrites them.
- **Voter guards** are shared with run gates (`vote-policy.ts`): `prevent_self` bars the requester (a deleted requester never matches, so the guard stays fail-closed), the voter must hold a required role, `reason_required` needs a non-blank reason. Each caller maps a denial to its own error class.
- **Distinct principals.** An approving voter contributes one evaluator vote per required role they hold, and `evaluateGate`'s bipartite matching lets them fill only one slot.
- **One vote per person**, backed by the unique index.
- **Expiry.** A vote on a request past `expires_at` marks it `expired` and is refused. `expireDue` expires the rest (to be driven by the job queue).
- **Audit.** `approval.requested` on creation; `approval.approved` (with the approving principals and roles), `approval.rejected`, `approval.superseded` and `approval.expired` on resolution.

## Errors

| Domain error | Base | tRPC code |
|---|---|---|
| `ApprovalNotFoundError` | `NotFoundError` | `NOT_FOUND` |
| `ApprovalNotPendingError`, `SelfApprovalError`, `ApprovalReasonRequiredError`, `DuplicateApprovalVoteError` | `BadRequestError` | `BAD_REQUEST` |
| `NotAuthorizedToApproveError` | `ForbiddenError` | `FORBIDDEN` |

## tRPC surface

`approval.list | get | vote`, all workspace-scoped (a non-member gets `NOT_FOUND`). There is no `create`: requests are opened by product domains through `ApprovalService.request`, never directly by a client.
