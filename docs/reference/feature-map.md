---
title: Feature map — MVP scope
description: Sorts deploy-governance features into MVP versus Post-MVP against the "GitHub write ≠ deploy" wedge.
type: reference
status: active
created: 2026-07-04
updated: 2026-10-01
confidence: medium
owner: andrea
tags: [reference, mvp, scope, feature-map, prototype]
related:
  - ../adr/0002-mocco-is-an-independent-authorization-layer.md
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../adr/0005-tech-stack-vercel-native-next-fullstack.md
  - ./roadmap.md
---

# Feature map — MVP scope

> Scope of the **deploy governance** product line only. Mocco's other product lines and their order are in the [roadmap](./roadmap.md).
>
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
| Commit sync | **Live** | Verify-first GitHub webhook (`push`/`installation`/`installation_repositories`) → tenant-isolated `mocco_commits` sync, deferred via `waitUntil`. Feeds the candidate-queue read path |
| Commit detail / config parse | **Live** | Per-commit `.mocco.yml` fetched at its SHA in the same deferred pass, parsed by the slice-1 `MoccoConfigParser`, and snapshotted 1:1 into `mocco_commit_configs` (best-effort per commit). The frontend commit-detail page renders the parsed steps from a pure DB read (`integration.commitDetail`). Observation slice (connect → commit queue → commit detail) is now complete; execution/gates are the next epic |
| **GitHub App + Cloud OIDC** ★ | **Not drawn** | Dispatch/webhooks (App) + STS trust (OIDC). This wiring is what makes gating real |
| Workspace model (backend) | **Live** | `mocco_workspaces`/`mocco_members`, DB-enforced invariants — see [workspace model](./workspace.md) |
| Workspace UI + invite flow | Not drawn | client plugin + screens land together (session-type parity) |

**MVP line**: connect a repo, define a gate, and a production deploy is **provably blocked** until an authorized role resumes (the credential broker proves it, recorded in the audit log). The two not-yet-drawn MVP items (`credential gating`, `GitHub App + OIDC`) were left out of the prototype because they are heavier on the backend than on screens — **without these two, "the gate is actually enforced" does not hold.**

## Post-MVP — after the wedge holds

Many are already drawn in the prototype (designed, but deferrable).

### Product line 1 — OTA release management (#99)

The first product after deploy governance, in phases set by the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md).

| Feature | Status | Description |
|---|---|---|
| Version policy and native force update | **Live** | Minimum, recommended and blocked versions per store app; tighten changes gated, relax changes reviewed after. See [OTA version policy](./ota-version-policy.md) |
| Gate existing OTA tools | **Live** | Mocco holds the EAS / CodePush / hot-updater publishing token and releases it only to a step behind a resumed gate. See [OTA external credentials](./ota-external-credentials.md) |
| Hosted Expo Updates | **Live** (in review) | Mocco serves updates to the stock `expo-updates` client (ADR 0021); the key stays in CI (ADR 0022); promotions to protected channels need approval (ADR 0020). See [Mocco-hosted OTA](./ota-hosting.md) |

### Product line 2 — Feature flags (#101)

Flags v1, per the [feature flags design](../specs/2026-09-24-feature-flags-design.md), [ADR 0023](../adr/0023-flag-targets-are-evaluation-scopes.md) and [ADR 0024](../adr/0024-flags-openfeature-flagd-ruleset-ofrep.md).

| Feature | Status | Description |
|---|---|---|
| Flag targets ("Environments") | Live | Evaluation scopes, each with its own versioned ruleset ([reference](./flags.md)); `flags:read` keys bound to one environment read it from `GET /v1/flags/ruleset` (ETag, 304); protected by a change gate |
| Flags, variants and targeting | Live | Boolean, string, number and JSON flags; rules on context attributes, segments, percentage rollout (`mocco-v1` bucketing) |
| Governed changesets | Live | Changes to a protected target are approval requests with a diff (ADR 0020) |
| Kill switch | Live | One-way, ungated, audited; restore is gated |
| Server SDK (local evaluation) | Live | `@mocco/flags-core` and an OpenFeature Node provider over the ETag'd flagd-compatible ruleset |
| Client SDKs (OFREP) | Live | OFREP bulk and single evaluation (client-visible flags only), the SSE change stream, `@mocco/openfeature-web` and `@mocco/openfeature-react-native` (offline copy, foreground refresh); React through `@openfeature/react-sdk` |
| Telemetry and stale flags | Live | SDKs send per-minute evaluation counts (`POST /v1/flags/telemetry`, hourly rollups); a daily job finds unused, never-evaluated and fully rolled-out flags; badges, dismiss-until and a weekly digest |
| Flags-as-code | Not drawn | `.mocco/flags.yml` on the default branch produces changesets that still pass the gate |

### Product line 3 — Messenger (#95)

The first slice of the [messenger design](../specs/2026-09-24-messenger-design.md): in-app "contact us" for signed-in users ([reference](./messenger.md)).

| Feature | Status | Notes |
|---|---|---|
| Conversations and identity | Prototype | `/v1/messenger`: sessions for users the app's server signed (HMAC), conversations with categories, seq-numbered idempotent messages, read positions, per-contact limits |
| Team inbox | Prototype | The project's **Inbox** tab: setup (identity secret shown once), open/closed lists with unread, the thread with replies and internal notes, the user's current and starting app context, close/reopen, blocking, categories and secret rotation; Discord alerts through the Mocco preset ([customer guide](../customer/messenger/contact-us.md)) |
| React Native SDK | Prototype | `MessengerClient` in `@mocco/sdk-core` and headless hooks in `@mocco/react-native/messenger` (pure JS, Expo Go) |
| Attachments | Prototype | Up to 3 screenshots per message through object storage, verified on send, served with short-lived links; thumbnails in the inbox |
| Push replies | Prototype | Devices register Expo push tokens; a team reply is pushed unless already read; gone devices are disabled |

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
| Ops — Monitors/Incidents | Not drawn | Post-deploy health/incident integration. Now its own product line — see the status page in the [roadmap](./roadmap.md) (#103) |
| Billing / Plan | Not drawn | Usage/plans. Needed for billing, unnecessary to prove value |
