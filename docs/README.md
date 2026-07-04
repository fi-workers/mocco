# How to use this repo's docs/ (LLM Wiki)

This folder is a knowledge base for LLM agents to read, navigate, and update efficiently across sessions. Read this document and `index.md` first before starting work.

## Entry order (at session start)

1. `docs/index.md` — top-level MOC, category map
2. The document for your work topic → follow the links

## Folder roles

| Folder | What | Update rule |
|---|---|---|
| `adr/` | Architecture decisions (immutable) | Add-only. Reversals become a new ADR + `superseded_by` |
| `reference/` | Single-source-of-truth reference | Update immediately when code changes |
| `concepts/` | Domain knowledge and the "why" | Rarely changes |
| `guides/` | How-tos and procedures | Update when procedures change |
| `specs/` | Feature design (pre-implementation) | Written before implementation |
| `meta/` | Rules for the wiki itself | schema/conventions/changelog |

## Authoring rules (summary — full version in `meta/conventions.md`)

- Frontmatter is required on every document (schema: `meta/schema.md`)
- Internal links use relative paths + `.md` (`[title](../adr/0001-x.md)`)
- Filenames: lowercase-hyphen, no spaces, emoji, or special characters. Content is in English by default
- One document = one topic. Self-contained (understandable without other documents)
- State the source for facts (code path/commit/external link). Mark guesses and unverified claims as `confidence: low`

## Two-layer decision record

- `adr/` — **why** a decision was made (immutable, per-decision). Reversals become a new ADR.
- `../CHANGELOG.md` — **what** changed (user-facing releases).

## Prohibited

- Creating a document without frontmatter
- Editing ADR body content after the fact (reversals become a new ADR)
- Leaving a document in contradiction with the code (mark stale or fix immediately when a contradiction is found)
- `rm`-ing files (archive them instead)
