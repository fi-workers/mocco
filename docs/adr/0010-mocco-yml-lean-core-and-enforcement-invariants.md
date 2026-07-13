---
title: "`.mocco.yml` stays a lean governance file; enforcement invariants are broker-side"
description: Keeps .mocco.yml a lean governance file, placing enforcement invariants broker-side and rejecting speculative CI-style extension fields.
type: adr
status: accepted
created: 2026-07-12
updated: 2026-07-12
confidence: high
owner: andrea
tags: [adr, mocco-yml, governance, schema, security]
related:
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ./0004-executor-agnostic-core-with-adapter-contract.md
  - ../reference/mocco-yml-spec.md
---

# 10. `.mocco.yml` stays a lean governance file; enforcement invariants are broker-side

Date: 2026-07-12

## Status

Accepted. Refines [ADR 0003](./0003-core-model-is-pause-resume-gates-no-env.md) (pause/resume gates), [ADR 0004](./0004-executor-agnostic-core-with-adapter-contract.md) (executor-agnostic), and the [`.mocco.yml` spec](../reference/mocco-yml-spec.md). Product of an adversarial four-lens review (CI-systems fidelity · governance/security · schema-evolution · YAGNI).

## Context

`.mocco.yml` is Mocco's governance declaration (steps + gates), not a CI engine — steps reference a *workflow* the executor runs (GHA today). A proposal to pre-design flexible extension points (`needs`/DAG, `when` conditionals, `inputs`/`outputs`, `extends`/`include`, `concurrency`) modeled on GitLab CI / Argo / Tekton was reviewed and rejected. Four independent conclusions converged:

- **The zod schema is additive by construction** — new optional fields (and a widened `steps` item) don't invalidate any existing file. Reserving slots *now* has nonzero cost (surface, generated JSON Schema, tests, reader confusion) and zero benefit; adding on real need costs nothing later.
- **Those fields describe *execution*, not *governance*** — they would turn `.mocco.yml` into a second, lagging CI DSL competing with the workflow it references (the adoption killer ADR 0004 warns against).
- **Each redefines "the preceding gate"** — the single predicate enforcement rests on — and can silently sever the gate→credential guard while the file still *looks* governed in review. They are security-dangerous, not merely speculative.
- **They carry concrete evolution traps** (the step/gate union can never be a `z.discriminatedUnion` on `run`/`gate`; the duplicate-name refine breaks the moment a non-`run` item lands).

## Decision

### 1. Keep the core lean

The schema is only: `version`, `pipeline`, `steps[]`, where an item is a **step** (`run`, `executor` opaque, `with` free-form) or (later) a **gate** (`resume:[{role,count}]` AND, `prevent_self`, `reason_required`), and a step may carry `credential` (`provider`, `role`, `ttl`). The warranted flexibility is exactly: `with` (adapter seam — keeps GHA words out of core), the structured `resume[]` (the N-of-M primitive), and `provider` as an open string. Nothing else.

**Do NOT add** `needs`/DAG, `when`, `inputs`/`outputs`, `extends`/`include`, `concurrency`, `safety`, `timeout` speculatively. Add a field only when a concrete case appears — and, for the governance-affecting ones, only with the enforcement semantics in §3 designed first. Matrix/retry/cache/artifacts stay in the referenced workflow, never in core.

### 2. Enforcement lives at the broker, and the file is a *request* not a grant

- **`credential` in the file is a request.** The authoritative grant is broker-side: an allowlist keyed on `(repo, pipeline, resumed-gate) → allowed providers/roles/max-ttl`. A repo author writing `credential: { role: admin, ttl: 12h }` grants nothing the broker's trust config doesn't already permit. The broker also **allowlists executors** — a step on an executor with *ambient* cloud credentials (self-hosted runner with an instance profile) bypasses the broker, so governed steps run only on broker-only executors.
- **Fail closed everywhere the runtime can't decide** — ambiguity, unsatisfiable gate, precondition regression → deny/Blocked+escalate, never auto-allow/auto-relax.

### 3. Invariants any future field must preserve (design these before shipping the field)

- **"Preceding gate" = graph dominance** (once `needs`/DAG exists): a credentialed step is guarded only if a resumed gate lies on *every* path to it. Lint rejects a credentialed step with no dominating gate; the broker default-denies on ambiguity. The credential↔gate link is **explicit** (`credential.gate: <gate-id>`), not adjacency-inferred.
- **Gates are unconditional** — `when`/conditions may never skip a gate or a credential-guard edge; a gate that *might* be skipped does not count as a dominator.
- **N-of-M counts distinct principals** (bipartite matching — one human fills at most one slot; a person in two roles cannot cover two). `prevent_self` is an **identity set** (author, committer, triggerer, and the author of the gate's own commit), not a boolean.
- **Provenance binding** — an approval authorizes a specific commit SHA / artifact digest; the adapter binds execution to the run's pinned SHA (no free `with.ref` running unreviewed code).
- **Config integrity** — a run pins the *fully resolved* config (repo file ⊕ any org policy, each by immutable SHA) and the snapshot hash covers the merged artifact. `when`/credential fields reference only run-immutable facts, never triggerer inputs or wall-clock.
- **Terminal outcomes are declared** — gate `expired` → auto-reject → Blocked (never auto-resume); rejection/failure → deny/revoke creds, halt downstream, notify.
- **Guaranteed-run finalizer** (`finally`/`on_exit`, governance-scoped) seals the audit chain, revokes credentials, and notifies on *any* terminal outcome.
- **Audit is a system property, not a file toggle** — the append-only hash chain is always on and org-enforced; it records the concrete resuming principals + their roles as-of-resume. (Drop `audit.hash_chain` as a config field.)
- **Preconditions** (`require_merged_to`, `require_status_checks`, `require_code_owner_review` — the GitHub-rulesets analog) are a first-class entry gate, verified fail-closed and **re-verified at credential-issue time** (a status check can regress or the branch be force-pushed after approval).
- **Break-glass** is first-class: a named role, mandatory reason, short ttl, a mandatory post-hoc review gate, a red audit flag — and it **still goes through the broker**.

### 4. Evolution mechanics (cheap now, prevents bugs)

- **Gates land as `version: 2`** with an explicit `kind: 'step' | 'gate'` discriminator (`z.discriminatedUnion('version', …)` and, inside v2, `z.discriminatedUnion('kind', …)`). A bare `z.union([step, gate])` on presence of `run`/`gate` cannot be a zod discriminated union and doubles error noise.
- **Identity/uniqueness moves to an effective id** (`id ?? run ?? gate`) *in the same change* that introduces the first non-`run` item — the current `run`-based duplicate check silently breaks (gates have no `run`) otherwise.
- **`.strict()` stays** (fail-closed is correct for a control plane); the unknown-key error carries a version hint. No `x-`/extensions passthrough.
- **No silent-on defaults for security fields** — a field is additive only if its *absent* value reproduces today's behavior; `prevent_self: true` as a default is a disguised break, so such fields ship required-in-v2 or explicit-off.
- **`with` is validated in two phases** — untyped `z.record` in the core (ADR 0004), with each adapter registering a `strictObject` validated at the service boundary.
- **`extends`/`include` is a resolution layer, not a schema field** — fragments get their own all-optional schema, the core validates only the *resolved* document, and merge is a **per-field strictness lattice** (gates add-only, counts raise-only, roles add-only, ttl shrink-only, `prevent_self`/`reason_required` false→true) that **rejects** any loosening or incomparable merge. Org policy is expressed as existence/invariant predicates the resolved config must satisfy, not a positional merge.

## Consequences

- Effort shifts from CI-style flexibility to **governance depth**: broker allowlist, provenance binding, preconditions, finalizer, mandatory audit, break-glass. These make the wedge ("a prod deploy is provably blocked until an authorized role resumes") real; the flexibility does not.
- N-of-M-per-role is a **differentiator** (GitLab-deployment-approvals class), beyond GHA environments' single-reviewer model — worth stating in product framing.
- `.mocco.yml` stays small and non-redundant with the team's existing workflow YAML, protecting adoption.
- The generated `mocco.schema.json` stays honest for the *version* axis but cannot express cross-field (`superRefine`) rules or `extends`; those belong to a resolver/language-server, documented as such.

## Reversal conditions

- If a real customer pipeline needs parallel fan-out, add `needs`/DAG — but only with the dominance-based guard (§3) designed first. If enough repos in one org need shared policy, add `extends` — but only with the lattice + resolved-config pinning (§4) designed first. Never add a governance-affecting field as "just a field."
