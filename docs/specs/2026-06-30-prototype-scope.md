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
- Hint at the long-term vision (ops control plane) via disabled nav items (Monitors, etc.).

## Screen list (click-through)

1. **Dashboard** — connected repos, N pending approvals, recent deploys, current SHA per environment.
2. **Deploy Queue (Commit Sync)** ★core — the queue of main commit candidates: SHA, message, author, runnable workflow, environment, approval status, run status. Vercel-deployments feel.
3. **Run Detail / Approval** ★core — a single OrchestrationRun:
   - State machine visualization: `Discovered → Queued → PendingApproval(blocked) → Approved → ReadyToRun → Dispatching → Dispatched → Running → Succeeded|Failed`
   - Multi-approval rules (e.g., SRE ×2 AND Security ×1), `pending_approval_count`
   - Self-approval block badge (triggerer/committer have the approve button disabled)
   - Approval token card (bind: sha/env/workflow_hash, ttl, single-use)
   - Approval↔dispatch separation (even after approval is satisfied, Dispatch is a separate button)
   - Outdated warning (shows a rejection if this SHA is an ancestor of the currently deployed SHA)
   - Verify result, retry / rollback buttons
4. **Environment Policy (.mocco.yml)** — per-environment cards + raw YAML view:
   - tier, allowed_to_deploy ↔ approvers **separated**, approval rules (N-of-M), prevent_self_approval
   - concurrency mode (oldest_first/newest_first…), safety (prevent_outdated), preconditions, secrets_scope
5. **Verify Action** — workflow YAML snippet (`mocco/verify@v1`) + 17-item verification checklist + an "unsafe" (Verify removed from the workflow) detection indicator.
6. **Audit Log** — structured event timeline, hash chain badge (append-only/tamper-proof), actor/result/sha/env filters.
7. **Settings** — GitHub App install / connected repos, policy override (org-level).

## Non-goals (not done in the prototype)

- Real GitHub API calls, real auth, real workflow dispatch, DB
- Full responsive polish/accessibility coverage (desktop click-through first)
- Backend logic (approval/verify/queue are only "faked" via screen transitions)

## Mock data

- repo: `acme/deploy-service` (fictional example), environments: production/staging/preview
- 5–6 commits, a few runs (one per state machine stage), ~10 audit events
- Stored statically in `docs/prototype/mock/data.js (static `window.MOCK` object)`
