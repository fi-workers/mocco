---
title: Slice 7 — Credential broker (the un-bypassable enforcement)
description: A step's workflow requests cloud credentials from mocco at runtime; the broker issues them ONLY if the run reached that step through its required resumed gate AND the request is within a workspace allowlist (the .mocco.yml `credential` is a request, the allowlist is the authority). Fail-closed. Stub CredentialProvider now; real AWS OIDC STS is user-side later. This is the feature-map ★ that makes "write ≠ deploy" actually hold.
type: spec
status: active
created: 2026-07-29
owner: andrea
tags: [spec, slice, credential-broker, enforcement, security]
related:
  - ../../adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md
  - ../../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../../adr/0011-external-api-surface-architecture.md
  - ../../reference/feature-map.md
  - ./2026-07-27-slice5-gates-approval-design.md
---

# Slice 7 — Credential broker

## 1. Purpose & scope

Everything to date is **orchestration-level**: mocco won't dispatch a gated step until it's resumed, but a manual `workflow_dispatch` outside mocco can still run the step. The credential broker closes that hole and makes the product thesis real: a step's workflow requests cloud credentials **from mocco at runtime**, and the broker issues them **only if** the run reached that step through its required **resumed gate** — otherwise DENY. Even if someone bypasses orchestration, without credentials the deploy can't happen.

**Authority model (the crux):** the `.mocco.yml` `credential` field is a **request**; the authority is a workspace-configured **allowlist** (`mocco_credential_grants`). A repo author cannot self-grant anything the workspace's trust config doesn't already permit.

**In scope** (2 sequential PRs, each base=main): the `.mocco.yml` `credential` field + its lint (a credentialed step must name a real gate in its pipeline); the `mocco_credential_grants` allowlist table + management; the pure allowlist evaluator; the **broker endpoint** (`POST /api/ext/credentials`, per-run-token authed) + the fail-closed gating decision; a **stub `CredentialProvider`**.

**Out of scope (deferred):** real AWS OIDC STS (the `CredentialProvider` swap — user-side wiring); precondition re-verify at issue time (status-check regression / force-push); the executor allowlist (excluding ambient-credential runners); break-glass; `credential_tokens` issuance audit (folds into the later audit slice); graph-dominance for `needs`/DAG (v1 pipelines are linear — a named gate before the step suffices).

## 2. Key decisions

- **Allowlist is authoritative** (ADR 0010). The broker matches the step's `credential` request against `mocco_credential_grants`; no matching grant → DENY. This is what makes `.mocco.yml` a request, not a grant.
- **Fail closed everywhere.** Unknown/expired token, step not actually dispatched by mocco, gate not resumed, no matching grant, ambiguity → DENY. Only an all-checks-pass path issues credentials.
- **The per-run `callbackToken` is the workflow's auth to the broker** — the same token model as the callback (sha-256 vs the run's stored hash). A manual `workflow_dispatch` never has it, so it can't even ask.
- **Explicit credential↔gate link** (`credential.gate: <gate-name>`) — not adjacency-inferred. The parser lints that the named gate exists in the pipeline; the broker checks that gate's `run_gate` is `resumed`.
- **Stub `CredentialProvider` behind an interface** — `issue(grant) → Credentials | deny`. The stub returns a clearly-fake credential on ALLOW and is swapped for AWS OIDC STS later. The broker's decision logic is provider-agnostic.

## 3. Data flow

```
step workflow (running in GitHub Actions / generic) needs cloud creds
   → POST /api/ext/credentials { runId, stepIndex, token, provider, role }   (token = per-run callbackToken)

CredentialBroker.issue (fail-closed, in order):
   1. resolve run by runId; verify sha-256(token) == run.callbackTokenHash        (else DENY)
   2. the run_step[stepIndex] is `dispatched`|`running`                            (mocco actually advanced here — not a bypass; else DENY)
   3. the step's pinned `credential.gate` names a run_gate whose state == `resumed` (else DENY)
   4. the (workspace, repo, provider, role) request matches a mocco_credential_grants row,
      and requested ttl <= grant.max_ttl                                          (allowlist authority; else DENY)
   5. CredentialProvider.issue({provider, role, ttl}) → Credentials               (stub now)
   → 200 { credentials } | 403 DENY (fixed generic body; the reason is logged, never leaked)
```

The step's `credential` is read from the run's **pinned config snapshot** (`commit_config`, already immutable per run) — never re-fetched, so it can't change after trigger.

## 4. Data model

- **`mocco_credential_grants`** — the workspace allowlist. `workspace_id`, `repo_id`→repos, `pipeline` text, `gate_name` text, `provider` text, `role` text, `max_ttl_seconds` int; uniq `(workspace_id, repo_id, pipeline, gate_name, provider, role)`. A row means "for this repo+pipeline, a step gated behind `gate_name` may receive `role` from `provider` for up to `max_ttl_seconds`."
- No `credential_tokens` table this slice (issuance audit → the audit slice). The broker logs decisions.

## 5. `.mocco.yml` `credential` field

The v2 `stepItemSchema` gains an optional `credential`: `{ provider: string, role: string, ttl: number (seconds), gate: string }`. Parser `superRefine` (fail-closed): if a step has `credential`, `credential.gate` MUST equal the `name` of a `gate` item earlier in the pipeline (a dominating gate — linear v1); else a schema error. `mocco.schema.json` regenerated.

## 6. Components

- **Pure `evaluateGrant(request, grants)`** (`domain/governance/` or `domain/credential/`) — given the request `{repoId, pipeline, gateName, provider, role, ttl}` and the workspace's grants, return `allowed | denied(reason)`. Unit-tested SSOT for the allowlist match (exact match + ttl ≤ max_ttl).
- **`CredentialProvider` port** — `issue(grant: {provider, role, ttlSeconds}): Promise<Credentials>`. **`StubCredentialProvider`** returns `{ kind: 'stub', provider, role, expiresAt, value: '<stub>' }`; the real AWS provider is a later swap.
- **`CredentialBroker` service** (anemic) — the §3 fail-closed decision: resolve run + verify token (reuse the run's token model), check step status + gate resumed (via RunGateRepo), `evaluateGrant` against `CredentialGrantRepo`, then `CredentialProvider.issue`. Returns credentials or a typed DENY.
- **`CredentialGrantRepo`** (ADR 0012) + `RoleService`-style `GrantService`/tRPC for managing grants (create/list/delete, workspace-scoped) + a minimal Access-adjacent UI (or defer UI; tRPC is enough to seed).
- **ext route** `POST /api/ext/credentials` (Hono, `transport/ext`) — parse, delegate to `CredentialBroker`, return creds (200) or a fixed generic 403; never leak which check failed.

## 7. PRs (sequential, each base=main)

1. **Config + allowlist + evaluator** — `.mocco.yml` `credential` field + lint (gate must exist) + regenerated schema.json; `mocco_credential_grants` migration + `CredentialGrantRepo` + DTOs + `GrantService`/tRPC (+ optional minimal UI); the pure `evaluateGrant` + tests. No broker endpoint yet.
2. **The broker** — `CredentialProvider` port + `StubCredentialProvider`; `CredentialBroker` (the fail-closed §3 decision, reusing the run token model + RunGateRepo + `evaluateGrant`); `POST /api/ext/credentials` ext route; fail-closed tests (each DENY branch: bad token, step not dispatched, gate not resumed, no grant, ttl too high; and the one ALLOW path issues stub creds).

## 8. Testing

Fail-closed is the product property — test every DENY branch explicitly (pglite + injected `StubCredentialProvider`/fakes; `expectOne` from rows):
- bad/absent token → DENY; a manual (no-token) request → DENY.
- step `pending` (never dispatched) → DENY even with a valid token.
- `credential.gate` not resumed (pending/rejected) → DENY.
- no matching grant, or requested `ttl > max_ttl` → DENY.
- all pass → issue: `CredentialProvider.issue` called with the granted `{provider, role, ttl}`, creds returned.
- tenant isolation: a grant/run in another workspace never satisfies.

## 9. Deferred & open

**Deferred:** real AWS OIDC STS (`CredentialProvider` swap, user-side trust config); precondition re-verify at issue time; executor allowlist (ambient-cred runners); break-glass; issuance audit (`credential_tokens` → audit slice); DAG graph-dominance (linear v1 uses a named preceding gate).

**Open (non-blocking):**
- Grant granularity — this slice keys grants on `(repo, pipeline, gate, provider, role)`; whether `pipeline`/`gate` can be wildcards is deferred (exact match, fail-closed, for now).
- Whether the broker also binds the issued credential's identity to the resuming principals (audit-grade) — deferred to the audit slice.
