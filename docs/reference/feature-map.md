---
title: Feature map — MVP scope
type: reference
status: active
created: 2026-07-04
updated: 2026-07-04
confidence: medium
owner: andrea
tags: [reference, mvp, scope, feature-map, prototype]
related:
  - ../adr/0002-mocco-is-an-independent-authorization-layer.md
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../adr/0005-tech-stack-vercel-native-next-fullstack.md
---

# Feature map — MVP scope

> Based on the prototype click-through + ADR 0002–0005. Organizes "what to ship first (MVP) and what to defer (Post-MVP)" against the wedge.

## Wedge (the cutting criterion)

**GitHub write ≠ deploy.** The gate is **actually enforced** — because cloud credentials (OIDC/STS) are not issued until an authorized role resumes. GitHub Actions is merely the first adapter (executor-agnostic).

**MVP = only what's needed to make this one sentence hold end-to-end.** Making it prettier, faster, and broader comes later.

## Status labels

| Label | Meaning |
|---|---|
| **Live** | Actual code exists (Next app) |
| **Prototype** | A click-through mock screen exists |
| **Not drawn** | No screen yet |
| ★ | enforcement core — the wedge depends on it |

## MVP — what makes the wedge hold

Goal: connect repo → define gate → prove that **without approval, a production deploy can't obtain credentials and is blocked** + record it in the audit log.

### Governance — deploy loop

| Feature | Status | Description |
|---|---|---|
| Deploy Queue | Prototype | main commit = deploy candidate → run. Daily work surface + home |
| Run detail | Prototype | One run: which commit, pipeline status, gates, action bar (Resume/Reject/Dispatch/Stop) |
| Gate resume (approve) ★ | Prototype | Role-based resume, AND rule, `prevent_self`, reason required. approve ≡ resume |
| **Credential gating (OIDC broker)** ★ | **Not drawn** | STS issued only to a resumed+verified run. Even if you delete the Verify step, credentials can't be obtained — the real enforcement |
| Access (role → member) ★ | Prototype | Who can deploy/approve, separate from GitHub permissions. The `write ≠ deploy` surface |
| Pipeline & gate definition | Prototype | `.mocco.yml` = step + gate. Linear is enough for v1 (parallel DAG comes later) |
| Audit log | Prototype | Append-only hash chain. Approval/dispatch/credential events = compliance |

### Platform & Workspace — foundation

| Feature | Status | Description |
|---|---|---|
| Login (email+password) | Live | Vendor-neutral auth surface; Google SSO and GitHub account-linking land as separate PRs |
| Connect repo | Prototype | Install GitHub App → select repo → detect `.mocco.yml` → OIDC trust. Onboarding |
| **GitHub App + Cloud OIDC** ★ | **Not drawn** | Dispatch/webhooks (App) + STS trust (OIDC). This wiring is what makes gating real |
| Workspace model (backend) | **Live** | `mocco_workspaces`/`mocco_members`, DB-enforced invariants — see [workspace model](./workspace.md) |
| Workspace UI + invite flow | Not drawn | client plugin + screens land together (session-type parity) |

**MVP line**: connect a repo, define a gate, and a production deploy is **provably blocked** until an authorized role resumes (the credential broker proves it, recorded in the audit log). The two not-yet-drawn MVP items (`credential gating`, `GitHub App + OIDC`) were left out of the prototype because they are heavier on the backend than on screens — **without these two, "the gate is actually enforced" does not hold.**

## Post-MVP — after the wedge holds

Many are already drawn in the prototype (designed, but deferrable).

### Deploy loop depth

| Feature | Status | Description |
|---|---|---|
| Parallel fan-in DAG / matrix | Prototype | Branching, parallel `lint·unit·e2e`, conditional stages. v1 stays linear |
| Concurrency modes | Prototype | oldest/newest/newest-ready wait queue. MVP defaults to `oldest_first`, no UI |
| Verify Action UI | Prototype | 17-item early-fail checklist. Enforcement is the credential gate — this is secondary |
| Rollback / re-deploy | Prototype | Rollback to last-good SHA (outdated-exempt, separate approval). Button only |
| Break-glass | Prototype | Emergency path when a resumer is absent — red audit + after-the-fact review. After trust is built |

### Reach & operations

| Feature | Status | Description |
|---|---|---|
| Slack notifications | Prototype | Approval-request/deploy/override events → channel. Convenience (not correctness) |
| Org policy override | Prototype | WS rules a repo can't weaken (monotonic hardening). An enterprise concern |
| Multi-cloud (GCP WIF) | Not drawn | A second broker beyond AWS STS. One is enough to prove the model |
| Ops — Monitors/Incidents | Not drawn | Post-deploy health/incident integration. Roadmap (not the wedge) |
| Billing / Plan | Not drawn | Usage/plans. Needed for billing, unnecessary to prove value |
