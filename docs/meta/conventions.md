---
title: Wiki authoring conventions
description: Authoring conventions for the wiki — filenames, relative-path links, frontmatter, and the one-topic-per-document rule.
type: meta
status: active
created: 2026-06-30
updated: 2026-06-30
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
- **journal / spec**: `{yyyy-mm-dd}-{slug}.md`
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

## Changelog

Record the rationale for changes to this wiki's structure/schema/constitution in `./changelog.md`.
