---
title: Wiki meta changelog
description: Records the rationale behind changes to the wiki's own structure, schema, and governing conventions.
type: meta
status: active
created: 2026-06-30
updated: 2026-09-24
confidence: high
owner: andrea
tags: [meta, changelog]
related:
  - ./schema.md
  - ./conventions.md
---

# Wiki meta changelog

Records the rationale whenever the wiki structure/schema/constitution (AGENTS.md, schema.md, conventions.md) changes.

## 2026-06-30

- Established the initial wiki structure. Based on llm-wiki research (the owner's PKM conventions + 2025–2026 AGENTS.md/ADR best practices).
- Decisions: AGENTS.md as single source + CLAUDE.md mirror / relative-path links / three-layer ADR·journal·CHANGELOG / 8 required frontmatter keys (corrected on 2026-09-24; this entry said 7, the schema has always listed 8).
- Research source: an internal note (not imported into the public wiki)

## 2026-09-24

- Added `yarn docs:lint` (`scripts/wiki-lint.mjs`), which enforces `schema.md` and relative links; it runs in `yarn verify` and CI.
- `schema.md`: documented `description` as an optional key (every document already used it), `okf_version` as index-only, and that the type-specific keys are optional and unknown keys are errors.
- Added `../log.md`, the chronological record of doc changes, and its entry format in `conventions.md`.
- Fixed documents that did not meet the schema: frontmatter for 7 superpowers specs/plans, `type: design` / `design-spec` → `spec`, missing `updated` / `confidence` / `tags`.
- Reason: unattended agents (`../../WORKFLOW.md`) read and update the wiki, so the rules have to be checked by a machine instead of by memory.
