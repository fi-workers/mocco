---
title: Slice 8 — Audit log (append-only per-workspace hash chain)
description: An always-on, tamper-evident audit trail — every governance event (gate resume/reject, credential issue/deny, run trigger) is appended to a per-workspace hash chain; anyone can verify the chain is intact. A system property, not a config toggle (ADR 0010).
type: spec
status: active
created: 2026-07-29
owner: andrea
tags: [spec, slice, audit, hash-chain, compliance]
related:
  - ../../adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md
  - ../../reference/feature-map.md
  - ./2026-07-27-slice5-gates-approval-design.md
  - ./2026-07-29-slice7-credential-broker-design.md
---

# Slice 8 — Audit log

## 1. Purpose & scope

The governance loop is complete (gates + credential broker), but its decisions leave no durable, tamper-evident record. This slice adds the **audit log**: an append-only, per-workspace **hash chain** where each entry's `hash = sha-256(prev_hash || canonical(entry))`. Any observer can re-walk the chain and prove it hasn't been altered or back-dated. Per ADR 0010 the audit is a **system property, always on** — not a `.mocco.yml` toggle.

**In scope** (2 sequential PRs, each base=main): the `mocco_audit_log` table + `AuditService` (append + verify) + a pure canonicalize/hash function (the SSOT); then wiring the write-path so the governance events already emitted (gate resume/reject, credential issue/deny, run trigger) append audit entries, plus a read surface (tRPC + an audit table UI with a chain-intact badge).

**Out of scope (deferred):** signing entries with an external KMS (the sha-256 self-chain is the MVP); exporting the log; retention/rotation; cross-workspace global chain (per-workspace is the boundary).

## 2. Key decisions

- **Per-workspace chain.** Each workspace has its own chain (its own `prev_hash` lineage), so one workspace's volume/tampering never affects another; the chain boundary matches the tenant boundary.
- **Monotonic `seq` (bigserial) + the hash chain.** `seq` orders entries; `hash` binds each entry to its predecessor. A gap or a recomputed-hash mismatch on `verify` proves tampering.
- **Append is a pure-core + thin-service split.** A pure `chainEntry(prevHash, entry) → { canonical, hash }` (unit-tested SSOT); `AuditService.append` reads the workspace's last hash, computes, inserts. `verify` re-walks and recomputes.
- **The write-path emits from the services that already own the events** (GateService, CredentialBroker, RunService) — audit is a cross-cutting append at the decision point, recording the actor + subject + payload, incl. the resuming principals/roles as-of-resume (ADR 0010).
- **Fail-open on append, fail-closed on verify.** An audit-append failure must never break the governed action (log + continue — the action already happened); `verify` reports any break explicitly.

## 3. Data model

**`mocco_audit_log`** — `seq` bigserial PK; `id` uuid unique; `workspace_id` (index `(workspace_id, seq)`); `actor_user_id` → users (set null — an actor may be deleted); `action` text (as-const `AuditActions`: `gate.resumed | gate.rejected | credential.issued | credential.denied | run.triggered`, extensible); `subject_type` / `subject_id` text; `payload` jsonb; `prev_hash` text nullable (null = the workspace's first entry); `hash` text NOT NULL = `sha-256(prev_hash ?? '' || canonical(row))`; `created_at`.

## 4. Components

- **Pure `chainEntry(prevHash, entry)`** (`domain/audit/chain.ts`) — deterministic canonical serialization of the entry's stable fields + `sha-256`. Unit-tested SSOT (same input → same hash; order-independent-of-insertion-time; a changed field changes the hash).
- **`AuditRepo`** (ADR 0012) — `lastHash(workspaceId)`, `append(row)`, `listByWorkspace(workspaceId, sinceSeq)`, `all(workspaceId)` (for verify).
- **`AuditService`** — `record(workspaceId, { actorUserId, action, subjectType, subjectId, payload })`: read `lastHash`, `chainEntry`, insert; **fail-open** (log, never throw into the caller). `verify(workspaceId)`: re-walk all entries, recompute each `hash` from the running `prev`, return `{ intact: true } | { intact: false; brokenAtSeq }`.
- **Write-path wiring** — `GateService` (on resume→`gate.resumed`, reject→`gate.rejected`, recording the principals/roles), `CredentialBroker` (on issue→`credential.issued`, DENY→`credential.denied` with the reason), `RunService.trigger` (`run.triggered`) call `AuditService.record`. Injected (composition root), so tests can assert the append without HTTP.
- **Read surface** — an `audit` tRPC (`list` + `verify`, workspace-scoped) and an audit page (`/workspaces/[id]/audit`): the entries table + a **chain-intact badge** (green verified / red broken-at-seq), silent-polling per the React Query convention.

## 5. PRs (sequential, each base=main)

1. **Chain core** — `mocco_audit_log` migration + `AuditRepo` + pure `chainEntry` + `AuditService` (record + verify) + DTOs + exhaustive unit tests (chain determinism; verify detects a tampered/removed entry). No write-path wiring yet.
2. **Write-path + read** — wire `AuditService.record` into `GateService` / `CredentialBroker` / `RunService` (fail-open) + the `audit` tRPC (`list`/`verify`) + the audit page (table + chain-intact badge).

## 6. Testing

pglite + unit (`expectOne` from rows): pure `chainEntry` (determinism, field-sensitivity); `AuditService.record` appends with the correct `prev_hash` linkage; `verify` returns intact for a real chain and pinpoints `brokenAtSeq` when a row's payload/hash is mutated; append is fail-open (a forced repo error is logged, the caller is unaffected); write-path — a gate resume / credential issue / credential deny / run trigger each produce the expected audit entry; tenant isolation (a workspace's chain excludes others').

## 7. Deferred & open

**Deferred:** KMS/asymmetric signing; export; retention; the `credential_tokens` issuance detail (folds here as `credential.issued` payload); global cross-workspace chain.

**Open:** exact canonical form (stable key order over the entry's `{workspace_id, action, subject_type, subject_id, payload, actor_user_id}` — exclude `seq`/`created_at` from the hash so it's reproducible? — decide in PR 1: hash covers the semantic fields + `prev_hash`, not the DB-assigned `seq`/`created_at`, so the chain is verifiable from content alone).
