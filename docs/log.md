---
title: Wiki log
description: Append-only chronological record of what changed in docs/ and why, one entry per PR that changes docs.
type: journal
status: active
created: 2026-09-24
updated: 2026-09-25
confidence: high
owner: andrea
tags: [meta, log, wiki]
related:
  - ./index.md
  - ./meta/conventions.md
---

# Wiki log

What changed in the docs, oldest first. Entry format and rules: [conventions](./meta/conventions.md#changelog-and-log).
Structural changes to the wiki itself also get their rationale in the [meta changelog](./meta/changelog.md).

## 2026-09-24 — Mocco as an all-in-one platform: roadmap, research, designs

- Repositioned Mocco as an all-in-one developer platform in `index.md` (and the root `README.md` / `AGENTS.md`);
  deploy governance is its first product line and `reference/feature-map.md` now scopes only that line.
- Added [the product roadmap](./reference/roadmap.md), competitor research for ten product lines plus all-in-one
  platforms under `research/` (new folder), and one implementation design per product plus the shared
  [platform foundations design](./specs/2026-09-24-platform-foundations-design.md) under `specs/`. Research is
  `confidence: medium`; claims marked "(unverified)" were not confirmed.
- Docs touched: `index.md`, `reference/feature-map.md`, `reference/roadmap.md`, `research/*`, `specs/2026-09-24-*`,
  `meta/changelog.md`
- Source: PR #107

## 2026-09-24 — Agent orchestration harness and docs lint

- Added `yarn docs:lint` and made every document pass it: frontmatter for the 7 superpowers specs/plans that had none,
  schema-valid `type` values, and missing `updated` / `confidence` / `tags`. Values filled in this entry are
  `confidence: medium` because they were not re-verified against the code.
- `index.md` now links every ADR, the missing reference pages, and the superpowers specs/plans; `adr/README.md` lists
  ADRs 0007–0012 in its table.
- Added the [agent orchestration guide](./guides/agent-orchestration.md) for `WORKFLOW.md` and `scripts/agents/`.
- Docs touched: `index.md`, `README.md`, `adr/README.md`, `meta/schema.md`, `meta/conventions.md`,
  `meta/changelog.md`, `guides/agent-orchestration.md`, `guides/pr-workflow.md`, `reference/env.md`, `superpowers/specs/*`,
  `superpowers/plans/*`
- Source: branch `chore/agent-harness`

## 2026-09-25 — Projects and product enablement (ADR 0013)

- Added ADR 0013 (draft): projects sit below workspaces and scope every product after deploy governance; products
  are enabled per workspace, governance always on. Added the project model reference and pointed the backend
  conventions at the shared project procedures and the unique-constraint error path.
- Docs touched: `adr/0013-mocco-is-a-multi-product-platform.md`, `adr/README.md`, `reference/project.md`,
  `reference/backend-conventions.md`, `index.md`
- Source: branch `feat/platform-projects` (issue #108)

## 2026-09-25 — Stage0 canary and external heartbeat (ADR 0020)

- Added ADR 0020 (draft): Mocco's own alerts go through Mocco, guarded by a stage0 canary that
  crosses the public ingest path every 5 minutes and pings an external dead-man switch only when
  its Discord delivery is sent. Added the stage0 reference (setup, `mocco_ops_canaries`, the failure
  table), the plan, the env vars, and the canary marking and sent-listener in the notifications
  reference.
- Docs touched: `adr/0020-moccos-own-alerts-go-through-mocco-guarded-by-an-external-heartbeat.md`,
  `adr/README.md`, `reference/ops-stage0.md`, `reference/env.md`, `reference/notifications.md`,
  `reference/jobs.md`, `superpowers/plans/2026-09-25-stage0-canary.md`, `index.md`
- Source: branch `feat/stage0-canary` (issue #245)
