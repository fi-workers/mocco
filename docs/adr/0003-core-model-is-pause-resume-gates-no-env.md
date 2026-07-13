---
title: Core model is pause/resume gates — drop the env concept
description: Defines the core model as pause/resume gates inserted into a pipeline with role-based resume requirements, dropping the per-environment approval concept.
type: adr
status: accepted
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
decision_date: 2026-06-30
stakeholders: [andrea]
tags: [adr, model, gate, pause-resume]
related:
  - ./0002-mocco-is-an-independent-authorization-layer.md
  - ../concepts/glossary.md
---

# ADR 0003 — Core model is pause/resume gates (drop env)

## Context

The initial model treated a **per-environment (env) approval policy** (production requires 2 approvals, staging 0, …) as a first-class concept. Owner insight: env is actually unnecessary — the real primitive is a **pause point that says "approval required from here on."**

> "approve is really a pause, with a set of people who can resume. And you record that too."

This is the same concept as Argo Workflows' `suspend`/`resume` and ArgoCD's `▶play` gate. Mocco generalizes that gate on top of GitHub Actions.

## Decision

**Core model = pause/resume gates inserted into a pipeline. Drop the env concept.**

- A **pipeline** = ordered steps. **Gates** are inserted between them.
- A **gate** = a pause point. Config: resume requirements (roles, below), `prevent_self`, `reason_required`, and the **credentials** this gate guards (the role the next step receives).
- **Role-based permissions:** **a role exists → people belong to the role → you put the role into a gate's resume requirements.** e.g., `resume: [{role: sre, count: 2}, {role: security, count: 1}]` (AND-combined). Role membership is managed in one place (Access).
- **approve ≡ resume** — someone authorized by a required role continuing a paused pipeline. N-of-M = N people from that role must resume.
- **Every pause/resume is recorded in the audit log.**
- **No env.** Remove type entities like "production/staging". Gates define all governance, and credentials **bind directly to the gate**. A step name (e.g., deploy-prod) is just a label, not a type.

```
pipeline:  build ─ deploy-stg ─▶ gate(2 people) ─ deploy-prod
                                  ↑ pause/resume(=approve); this gate issues the credentials
```

## Consequences

- **Policy is per-gate, not per-env.** "prod needs 2" → "this gate needs 2 to resume". A gate can sit before a deploy, before a migration, anywhere.
- **Credential gating becomes more natural** — the gate issues the OIDC role (if it isn't resumed, the next step can't obtain credentials).
- Data model: delete the `Environment` entity → `Pipeline` + `Gate` + `Run` (step/gate progress).
- Prototype reframe: "Environment Policy" → "Pipelines/Gates", the pipeline stepper becomes step+gate, "approval" → "resume", remove env columns/badges.
- Terminology change → update the [glossary](../concepts/glossary.md).

## Reversal Conditions

- If customers strongly want a "grouped-by-environment view" (what's live on prod right now), reintroduce env as a **read-only label/view** (the governance axis is still the gate). Do not bring it back as a first-class entity.
