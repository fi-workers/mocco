---
title: Flag targets are evaluation scopes, not governance types
description: Feature flags get per-target state ("Environment" in the UI) as a pure evaluation scope — a named ruleset plus the SDK keys bound to it — with no built-in meaning; protection is an attached change gate in the GateRequirements shape, decided by ApprovalService, consistent with ADR 0003.
type: adr
status: draft
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
decision_date: 2026-10-02
stakeholders: [andrea]
tags: [adr, flags, governance, environments]
related:
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ./0020-approvals-outside-pipeline-runs.md
  - ../specs/2026-09-24-feature-flags-design.md
---

# ADR 0023 — Flag targets are evaluation scopes, not governance types

## Context

ADR 0003 dropped environments as a governance axis: policy lives on gates, and nothing in Mocco branches on a name like "production". Feature flags still need per-target state. The same flag key must resolve to different rules for the staging app and the production app, and each SDK must be bound to exactly one ruleset. Every flag product calls this an "environment", which is the word SDK users expect.

ADR 0003's reversal condition allows environments back as a label or a view, never as a type that grants or skips approval.

## Decision

1. **A flag target is an evaluation scope.** It is stored as `mocco_flag_environments`, labelled "Environment" in the UI, and is a named ruleset plus the SDK keys bound to it. It has no type, no built-in meaning and no ordering: there is no `production` kind, and no code reads a target's name.
2. **Protection is an attached change gate.** A target is protected exactly when it has a `change_gate`, which reuses the gate item's shape verbatim: `{ resume: [{ role, count }], prevent_self, reason_required }`. An unprotected target applies changes at once (audited). On a protected target, a change is a changeset decided by `ApprovalService` (ADR 0020) as a `pre_approval` with the gate as its pinned requirements. "Production needs two approvals" becomes "this target's change gate needs two", the same mental model as pipeline gates.
3. **Changing protection is gated by the current gate.** Removing or weakening a target's change gate is itself a request under the gate it replaces (as with OTA channels).
4. **Pipeline linkage is correlation only.** A target may later name a `linked_pipeline` (repo and pipeline) so the UI can show where a flag's code first shipped. It never grants or bypasses anything.

## Consequences

- No second notion of "environment" enters governance: the flag gate is a gate.
- Flag changesets, OTA promotions and version policies share one approval engine, voter rules and audit trail.
- Targets are cheap to create (a preview target per branch is just another scope).
- The UI word "Environment" is a label on a data partition; docs say so wherever it could be read as a governance type.
