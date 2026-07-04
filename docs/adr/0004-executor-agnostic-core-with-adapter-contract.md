---
title: Executor-agnostic core + adapter contract (trigger event + callback + credential gate)
type: adr
status: accepted
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
decision_date: 2026-06-30
stakeholders: [andrea]
tags: [adr, architecture, executor, adapter, webhook]
related:
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ../reference/mocco-yml-spec.md
  - ../concepts/glossary.md
---

# ADR 0004 — Executor-agnostic core + adapter contract

## Context

ADR 0003 made the core = pipeline + pause/resume gates. Next insight (owner): **GitHub Actions terminology (workflow, workflow_dispatch, Verify Action, GitHub App, OIDC) is not a core concept.** GitHub Actions is just **one kind of executor** that runs steps. And the trigger can be generalized as "firing a webhook."

## Decision

**The core is executor-agnostic. GitHub Actions is split out as an adapter.**

### Three layers

1. **Core (vendor-neutral):** Pipeline / Step / Gate / Run / Role / Resume(=approve) / Audit. No GitHub words.
2. **Executor interface (adapter boundary):**
   - `start(step, ctx) → handle` — begin executing a step
   - `poll(handle) → status` / `logs(handle)` / `cancel(handle)`
   - `CredentialBroker.issue(gate/step, token) → creds | deny`
3. **Adapter (implementation):** the GitHub Actions adapter implements the interface above.

### Executor contract = trigger event + callback + credential gate

```
Mocco ──(trigger event: run_id, step, commit_sha, token, callback_url)──▶ Executor
Executor ──(callback: run_id, status / verify request / done)──▶ Mocco ingest
Executor runner ──(creds request + token)──▶ Mocco CredentialBroker ──▶ STS | deny
```

- **Trigger (outbound)** = "fire an event". For a generic executor, a **webhook POST**; for the GitHub adapter, **`repository_dispatch`** (a fire-and-forget webhook) or `workflow_dispatch`. → **the replaceable part.**
- **Callback (inbound)** = the executor correlates by `run_id` and fires back to Mocco (status/verify/done). **Not fire-and-forget.**
- **Enforcement comes from callback verification + credential gating, not the trigger mechanism.** Even if someone fires the trigger themselves (bypass), without a valid token the broker denies credentials → the deploy can't happen.

### GitHub Actions adapter mapping

| Core | GitHub Actions adapter |
|---|---|
| start(step) | `repository_dispatch` / `workflow_dispatch` (ref + inputs.commit_sha + token) |
| callback (verify) | `mocco/verify@v1` calls the Mocco verify endpoint |
| poll/logs | `workflow_run` webhook / runs API / log link-out |
| credential | OIDC trust — Mocco is the broker, STS only for verified runs |
| auth | GitHub App |

## Consequences

- **Product identity = "pipeline governance control plane"** (not a GitHub Actions tool). GitHub Actions = today's default adapter.
- Future adapters: GitLab CI / shell runner / k8s Job / **health-check and monitor steps** → ties into the "manage everything eventually (Better Stack)" vision.
- **What we're building now is the core + a single GitHub Actions adapter.** The point is not to build multiple adapters now, just to keep the boundary clean.
- `.mocco.yml`: a step's `executor` + `with` carry adapter-specific options. The core schema has no GitHub words. → [spec](../reference/mocco-yml-spec.md)
- Reorganize the glossary into two tiers: core/adapter.

## Reversal Conditions

- If demand for multiple adapters never materializes, keep the adapter abstraction thin (interface only, GitHub-only implementation). Preserve core neutrality.
