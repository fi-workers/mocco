---
title: Name the product Mocco
type: adr
status: accepted
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
tags: [adr, naming, branding]
decision_date: 2026-06-30
stakeholders: [andrea]
related:
  - ../index.md
---

# ADR 0001 — Name the product Mocco

## Context

In the plan for the GitHub Actions deploy governance control plane, the product name was undecided (open question #1 in the original `01 product definition`). The only candidates were descriptive names such as `GitHub Actions Approval & Trigger Control Plane`.

Meanwhile, fi-workers' existing in-house product "Mocco" (a private community chat SaaS) was shelved, and its codebase was split out as `mocco-community-legacy`. The short, easy-to-say name "Mocco" was now free.

## Options Considered

1. **Keep a descriptive name** (`Actions Deploy Gate`, etc.) — search-friendly but long and weak as a brand.
2. **Reuse Mocco** — short and memorable. However, its existing meaning (gathering + Core, "a warm digital living room") clashes with DevOps → needs a redefinition of meaning.
3. **Fully new naming** — costly and time-consuming, overkill at this stage.

## Decision

**Product name = Mocco.** Discard the old community-chat brand meaning, and do not confine the meaning to deploys.

- Do not adopt a narrow backronym (e.g., Merge→Orchestrate). The long-term vision is not limited to deploys.
- **Positioning:** deploy governance as the first wedge, gradually expanding into a **unified ops control plane** (à la Better Stack) covering health checks, monitoring, and incidents.
- Apply naming consistently across packages: repo `fi-workers/mocco`, config file `.mocco.yml`, Verify Action `mocco/verify@v1`.

## Consequences

- Replace all `your-org/verify` and `.orchestrator.yml` references wholesale with `mocco/verify` and `.mocco.yml`.
- The old Mocco (chat) notes in the Obsidian vault are subject to archiving (separate task).
- The "ops control plane" vision becomes the baseline for the roadmap and marketing copy.

## Reversal Conditions

- Revisit if a trademark/domain conflict is found, or if there is substantial user feedback that "Mocco" is confusing in a DevOps context.
