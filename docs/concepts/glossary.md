---
title: Glossary
description: Disambiguates easily-confused Mocco, GitHub Actions, and GitLab CI terms such as pipeline, workflow, run, deploy, and gate.
type: concept
status: active
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
tags: [concept, glossary, terminology]
related:
  - ./authorization-and-wedge.md
  - ../index.md
---

# Glossary

> Mocco, GitHub Actions, and GitLab CI terms get mixed up easily. Pin down the distinction between **pipeline / workflow / run / deploy** first.

> [!note] Model (ADR 0003) — no env, gates are the core
> Mocco does not use the environment (env) concept. **Inserting pause/resume gates into a pipeline** is all there is. → [ADR 0003](../adr/0003-core-model-is-pause-resume-gates-no-env.md)

## The confusing pairs first

| Term | What | Owned by | One line |
|---|---|---|---|
| **Workflow** | One `.github/workflows/*.yml`. The definition of jobs/steps | GitHub Actions | The **definition file** for "what to run" |
| **Pipeline** | A flow made of steps + **gates** between them | Mocco | The "step ─▶gate─ step" picture |
| **Gate** | A **pause point** in a pipeline. Has resume requirements (roles) | Mocco | "approval required from here" = a stop |
| **Run** | **One execution** of a pipeline for a specific commit | Mocco | Pauses at gates, resumes, and proceeds |

→ **Workflow is the definition, Pipeline is the flow, Gate is the stop point, Run is one execution.**

## pause / resume / approve (core)

- **Pause (suspend)** — the pipeline stops at a gate. Same as Argo `suspend`, ArgoCD `▶play`.
- **Resume** — an authorized person continues the stopped pipeline.
- **Approve ≡ Resume** — approval is not a separate concept; it is "an authorized person resuming a gate." All recorded in the audit log.
- **Role** — the unit of resume authority. **People belong to a role, and you put the role into a gate's requirements.** e.g., gate = `SRE ×2 AND Security ×1`. Role membership is managed in Access.
- **prevent_self** — the commit author/committer/triggerer cannot resume their own gate.

## Core — authorization and enforcement (vendor-neutral)

- **Dispatch (trigger)** — trigger a step of a gate-cleared run on the executor (fire an event). *How* it's fired is an adapter implementation detail.
- **allowed_to_deploy** — who can dispatch (trigger). A separate list, **distinct** from resume authority.
- **Authorization vs Identity** — authority (whether you can resume/deploy) is **owned by Mocco**; only identity (who the actor is) links to the outside. → [authorization model](./authorization-and-wedge.md), [ADR 0002](../adr/0002-mocco-is-an-independent-authorization-layer.md)
- **Approval Token** — a one-time ticket valid only for a specific run/SHA/gate. Not a general permission.
- **Credential Gating** — **the actual basis for being un-bypassable.** Mocco becomes the credential broker and issues credentials only to a gate-resumed run. Even if someone fires the trigger themselves, without a token it's denied.
- **config snapshot hash** — the `.mocco.yml` hash at resume time. If it differs from execution time (the policy changed in between), it's blocked.

## GitHub Actions adapter (implementation — not core)

> The following are implementation terms for the "GitHub Actions executor adapter." Other executors (GitLab/shell/k8s…) have different mappings. → [ADR 0004](../adr/0004-executor-agnostic-core-with-adapter-contract.md)

- **GitHub Actions** — the build/deploy execution engine. Mocco sits on top of it.
- **Workflow** — `.github/workflows/*.yml`. Owned by the team; we only **reference** it from a step.
- **workflow_dispatch / repository_dispatch** — the GitHub events (= fire-and-forget webhooks) Mocco uses to trigger a step. Separate `ref` (the branch the file is based on) ≠ `inputs.commit_sha` (the target).
- **Verify Action (`mocco/verify@v1`)** — the workflow's first step. Callback verification of "is this an approved run" + **early-fail UX** (not a security boundary; removable).
- **OIDC STS** — the GitHub flavor of credential gating. AssumeRole only for verified runs.
- **GitHub App** — adapter authentication (not a PAT).
- **Trigger + callback** — Mocco fires a trigger event, and the executor correlates by `run_id` to call back (status/verify/done). Not fire-and-forget.

## Safety and operations

- **Concurrency / Process mode** — serialize concurrent deploys of the same resource group. `oldest_first` (order-preserving) / `newest_first` (latest first, skip stale) / `newest_ready_first`. Equivalent to GitLab resource_group.
- **Outdated deploy** — attempting to deploy an ancestor (past) commit of the currently deployed SHA. `prevent_outdated: reject|skip`. Decided by ancestry in the commit graph.
- **Rollback** — redeploy the last successful SHA. Outdated but an explicit exception path (separate approval and audit).
- **Retry** — run again with the same SHA. Handles transient failures.
- **Stop / Cancel** — abort an in-progress run (awaiting approval or running).
- **Break-glass (emergency deploy)** — a bypass path for emergencies such as an absent approver. Requires a reason + mandatory after-the-fact review + a red audit flag.
- **Audit Log** — an append-only record of every governance action. Tamper-proof via a hash chain.

## State machine (a Run's states)

`Discovered → Queued → PendingApproval → Approved → ReadyToRun → Dispatched → Running → Succeeded`
Failures/exceptions: `Rejected` / `Blocked` (bypassed/blocked) / `Failed` (execution failed) / `VerifyFailed` (verification failed).

## (Removed) Environment / env

ADR 0003 **removes the env concept**. A policy like "production requires 2 approvals" is expressed as a **gate** ("this gate needs 2 to resume"). Credentials bind directly to the gate. A step name (deploy-prod, etc.) is just a label, not a type.
