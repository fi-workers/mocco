---
title: Wiki log
description: Append-only chronological record of what changed in docs/ and why, one entry per PR that changes docs.
type: journal
status: active
created: 2026-09-24
updated: 2026-09-24
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
