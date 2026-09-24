---
title: Wiki authoring conventions
description: Authoring conventions for the wiki — filenames, relative-path links, frontmatter, and the one-topic-per-document rule.
type: meta
status: active
created: 2026-06-30
updated: 2026-09-24
confidence: high
owner: andrea
tags: [meta, conventions]
related:
  - ./schema.md
  - ../README.md
---

# Wiki authoring conventions

## Filenames

- **adr**: `{NNNN}-{imperative-kebab}.md` — 4-digit zero-padded number + imperative verb phrase. e.g., `0001-name-the-product-mocco.md`
- **journal / spec**: `{yyyy-mm-dd}-{slug}.md`. One exception: `docs/log.md`, the single rolling log (type `journal`)
- **reference / concept / guide / overview**: a stable `{topic-kebab}.md` (no date — the name is the anchor)
- Common: lowercase-hyphen, no spaces, emoji, or special characters. English slug recommended (URL/link stability); content in English.

## Links

1. Internal links = **relative path + `.md`**: `[Adopt tRPC](../adr/0002-adopt-trpc.md)`
2. Section links = stable anchors: `[Authentication flow](../concepts/data-flow.md#authentication)` — don't casually rename a linked heading.
3. Put the same relative path in the `related:` frontmatter too, for bidirectional navigation.
4. Full URLs only for cross-repo references.
5. No `[[wikilink]]` (Obsidian-only — breaks in git/GitHub).

## Document unit

- One document = one topic. Self-contained (understandable without other documents).
- MOCs (overviews) growing faster than the source is a sign of health.

## Medallion gate (inherited from the owner's convention)

- Agents may auto-update `reference/` and `journal/`.
- **Promoting an ADR to `accepted` and finalizing a CHANGELOG release require human approval.**

## Changelog and log

- `./changelog.md` — the rationale for changes to this wiki's structure/schema/constitution.
- `../log.md` — a chronological record of what changed in the docs and why. Append one entry at the end whenever a
  PR changes docs (agents included):

  ```markdown
  ## YYYY-MM-DD — <short title>

  - What changed and why, in one or two lines
  - Docs touched: `reference/env.md`, …
  - Source: PR #N (or commit sha)
  ```

  Entries are never rewritten. Bump the log's `updated` when appending.

## Lint

`yarn docs:lint` checks the schema (`./schema.md`) and links mechanically. It is part of `yarn verify`, so a push
with a broken link or a missing frontmatter key is blocked.
