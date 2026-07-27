---
title: Slice 6 — GitHub Actions executor adapter
description: A second executor adapter (ADR 0004) — a run step with executor `github-actions` is dispatched to GitHub via repository_dispatch and reports back over the SAME neutral /api/ext/callback funnel. Introduces an executor registry (step.executor → adapter) so the core stays executor-agnostic. Buildable/testable now with a fake GitHub client; the real GitHub App wiring is user-side.
type: spec
status: active
created: 2026-07-28
owner: andrea
tags: [spec, slice, executor, github, adapter]
related:
  - ../../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../../adr/0011-external-api-surface-architecture.md
  - ../../reference/feature-map.md
  - ./2026-07-26-slice4-runs-execution-design.md
---

# Slice 6 — GitHub Actions executor adapter

## 1. Purpose & scope

The execution loop is Live with ONE adapter — a generic serverless executor. This slice adds a **second adapter, GitHub Actions**, without touching the core (ADR 0004): a run step whose `executor` is `github-actions` is dispatched to GitHub via `repository_dispatch`, the step runs in GitHub Actions, and the workflow reports back over the **same** neutral `POST /api/ext/callback` that `RunService.applyCallback` already funnels. The generic and GitHub adapters converge on one advance loop.

**In scope:** an **executor registry** (route `step.executor` → adapter; the core's single-executor injection becomes a map), the **`GitHubExecutor`** (`repository_dispatch` via the existing installation-token auth), run→repo→installation resolution inside the adapter, and fake-injected tests. Delivered as **2 sequential PRs, each base=main** (registry, then adapter).

**Out of scope (deferred):** the `workflow_run` webhook (status/logs observability — the callback already advances the run); the published `mocco/verify@v1` GitHub Action (a separate artifact — this slice only relies on the callback contract); a live GitHub App dispatching a real workflow (user-side wiring); and the **credential broker** (the next slice — until it lands, a manual `workflow_dispatch` outside mocco can still bypass an orchestration gate; documented, not closed here).

## 2. Key decisions

- **Executor registry (`Map<ExecutorId, Executor>`).** `RunService`'s single `executor` dep becomes a registry; `dispatchStep` looks up `step.executor`. An unknown executor is **fail-closed**: the run fails with a clear error/event, never a silent no-op. Adding an adapter = registering it at the composition root.
- **`ExecutorIds` as-const SSOT** (`generic`, `github-actions`) — no magic strings (per the enum-preference convention); the config's `executor` string is matched against these.
- **The GitHub adapter is vendor-coupled by design** (ADR 0004) and lives in `domain/execution/executors/github/*`. It reuses slice-3a's installation-token minting rather than re-importing octokit; the core keeps zero GitHub words.
- **The callback path is reused unchanged.** The GitHub workflow POSTs the same `/api/ext/callback` (with the per-run token) that the generic executor does — so `applyCallback`, token verification, and the advance/gate logic are untouched.

## 3. Architecture & data flow

```
RunService.dispatchStep(step)
   registry.get(step.executor)  ── unknown → fail-closed (run.failed)
        │
        ├─ 'generic'        → GenericExecutor.start   (existing)
        └─ 'github-actions' → GitHubExecutor.start:
              resolve run→commit→repo→connection (owner/name + installation)
              mint installation octokit (reuse slice-3a auth)
              repository_dispatch(event_type, client_payload={runId,stepIndex,commitSha,callbackUrl,callbackToken})
              → handle 'github:{owner}/{name}:{runId}:{stepIndex}'

GitHub Actions runs the step → the workflow POSTs the SAME /api/ext/callback (token) → applyCallback advances (unchanged)
```

## 4. Components

- **`ExecutorIds`** (as-const) + the registry: `RunServiceDeps.executor: Executor` → `executors: Map<string, Executor>` (or a thin `ExecutorRegistry` wrapper with `get(id)`). `dispatchStep` resolves the adapter by `dispatch.executor`; a miss throws `UnknownExecutorError` → `RunService` fails the run (`run.failed`, a `step.failed` with the reason).
- **`GitHubExecutor`** (`executors/github/provider.ts`): implements `Executor.start`. Injected with the integration GitHub provider (installation octokit / token minting) and the repos needed to resolve a run's repo + connection (`RunRepo`/`CommitRepo`/`RepoRepo`/`ProviderConnectionRepo`, or a small resolver). `start` fires `repository_dispatch` and returns the handle; fire-and-forget (enforcement is the callback).
- **Config**: a step's `executor: 'github-actions'` selects the adapter; `with` carries GitHub options (e.g. an `event_type` / workflow ref override) — opaque to the core.
- **Composition root** (`domain/execution/instance.ts`): builds the registry `{ generic: GenericExecutor, 'github-actions': GitHubExecutor }`; the GitHub adapter is wired only when the GitHub App is configured (else the registry omits it and a `github-actions` step fails closed with "GitHub not configured").

## 5. Testing

Fake-injected (no real GitHub App), mirroring the generic executor's tests + the integration `FakeCommitSource`:
- registry routes `generic` vs `github-actions` to the right adapter;
- an unknown/absent executor fails the run closed (not a silent stall);
- `GitHubExecutor.start` calls `repository_dispatch` with the correct `client_payload` (runId/stepIndex/commitSha/callbackUrl/callbackToken) for the resolved owner/name/installation (injected `FakeGitHubDispatcher`);
- the callback path still advances a github-dispatched run (reuses the existing `/api/ext/callback` + `applyCallback` tests).

## 6. PRs (sequential, each base=main — no stacked intermediate base)

1. **Executor registry** — `ExecutorIds` SSOT + `RunService` single-executor → registry lookup + fail-closed on unknown + tests (generic unchanged; unknown fails). Small, isolated refactor. **Merge to main.**
2. **GitHub adapter** — `GitHubExecutor` (`repository_dispatch`) + run→repo→installation resolution + composition-root registration (gated on GitHub config) + `with` options + fake tests. Built on the updated main. **Merge to main.**

## 7. Deferred & open

**Deferred:** `workflow_run` webhook (observability/logs link-out); the `mocco/verify@v1` Action artifact; live GitHub-App end-to-end (user-side); the credential broker (next slice — the real, un-bypassable enforcement).

**Open (non-blocking):**
- `event_type` for `repository_dispatch` — a fixed constant (e.g. `mocco-run-step`) vs configurable via `with`. Default to a constant; revisit if a repo needs multiple mocco workflows.
- How the workflow authenticates its callback: it echoes the per-run `callbackToken` from `client_payload` (same token model as the generic executor) — no separate GitHub-side secret needed for the callback in this slice.
