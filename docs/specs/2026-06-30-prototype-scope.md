---
title: Prototype scope & information architecture (IA)
type: spec
status: active
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
phase: prototype
target_date: 2026-06-30
implements:
  - ../adr/0001-name-the-product-mocco.md
tags: [spec, prototype, ia]
related:
  - ../prototype/README.md
---

# Prototype scope & information architecture (IA)

> Purpose: visually validate the Mocco design with a non-functional HTML click-through. Mock data only. → For management principles, see [prototype/README](../prototype/README.md).

## Design principles

- Surface the original four components (GitHub App / Commit Sync UI / Approval & Policy Engine / Verify Action) as screens.
- Make the **7 MVP gaps** from the GitLab gap analysis explicitly visible in the UI (self-approval block, approval↔dispatch separation, token binding, multi-approval rules, outdated rejection, concurrency modes, tamper-proof audit).

## Screen list (click-through)

> Updated 2026-07-04 to match the shipped prototype (the original draft predated ADR 0003's no-env reframe and the workspace group).

**Governance**

1. **Deploy Queue** ★core (home) — main commit candidates: SHA, message, author, workflow, gate status, run status, per-row progress steps. Vercel-deployments feel.
2. **Run Detail** ★core — a single run:
   - Pipeline DAG (steps + parallel fan-in) and state machine: `Discovered → Queued → PendingApproval(blocked) → Approved → ReadyToRun → Dispatched → Running → Succeeded|Failed`
   - Deploying-commit card (author, full message, SHA, branch)
   - Multi-resume rules (e.g., SRE ×2 AND Security ×1), self-approval block, approval token card (bind: sha/step/workflow_hash, ttl, single-use)
   - Approval↔dispatch separation, outdated warning, per-step logs, retry/rollback/stop actions
3. **Access** ★wedge (ADR 0002) — roles → members, GitHub permission vs Mocco authorization side-by-side (write ≠ deploy made visible).
4. **Pipelines & Gates** — the `.mocco.yml` pipeline (steps + gates) with per-gate cards; **Concurrency** and **Verify & enforcement** as sub-tabs (process modes; 17-item checklist; per-run credential decisions).
5. **Audit Log** — structured event timeline, hash chain badge (append-only), actor/result filters.
6. **Settings** — GitHub App install, org policy override.

**Workspace**

7. **Repos** — connected repos per GitHub org, `.mocco.yml` detection, pipeline/gate counts.
8. **Members** — workspace members and roles (owner/admin/member).
9. **Integrations** — GitHub App, cloud OIDC, notifications.

## Non-goals (not done in the prototype)

- Real GitHub API calls, real auth, real workflow dispatch, DB
- Full responsive polish/accessibility coverage (desktop click-through first)
- Backend logic (approval/verify/queue are only "faked" via screen transitions)

## Mock data

- repo: `acme/deploy-service` (fictional example)
- 5–6 commits, a few runs (one per state machine stage), ~10 audit events
- Stored statically in `docs/prototype/mock/data.js` (a static `window.MOCK` object)
