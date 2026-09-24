---
title: Frontmatter schema
description: Specifies the required and optional YAML frontmatter keys every wiki document must carry.
type: meta
status: active
created: 2026-06-30
updated: 2026-09-24
confidence: high
owner: andrea
tags: [meta, schema]
related:
  - ./conventions.md
  - ../README.md
---

# Frontmatter schema

Every document has YAML frontmatter. 8 required keys (`title`, `type`, `status`, `created`, `updated`, `confidence`, `owner`, `tags`); `description` and `related` are optional but encouraged, plus type-specific optional keys. Any other key is an error.

`yarn docs:lint` (`scripts/wiki-lint.mjs`) enforces this page; it runs in `yarn verify` and CI. Change the schema and the lint together.

## Required keys

```yaml
---
title: Human-readable title         # separate from the filename
type: adr | journal | guide | reference | concept | overview | spec | meta | research
status: draft | active | accepted | superseded | evergreen | stale | archived
created: YYYY-MM-DD
updated: YYYY-MM-DD
confidence: high | medium | low     # tracks LLM-generated/unverified information
owner: andrea
tags: [a, b]                        # at least one tag
---
```

## Optional keys (any type)

```yaml
description: One sentence on what the document covers   # OKF-recommended; shown in listings
related:                            # relative-path links, resolved from this file
  - ../adr/0001-name-the-product-mocco.md
```

`okf_version` is allowed only in `docs/index.md` (the bundle version, see `../README.md`).

Lists are written either inline (`[a, b]`) or as `- item` lines. Multi-line YAML scalars (`>`, `|`) are not used.

## Additional fields per type

All of these are optional.

| type | Additional fields |
|---|---|
| `adr` | `decision_date`, `supersedes` / `superseded_by`, `stakeholders` |
| `journal` | `session`, `commits: [sha…]` |
| `spec` | `phase`, `target_date`, `implements` (related ADR path) |
| `reference` | `code_refs: [src/…]` (corresponding source path — for stale detection when code changes) |

## Design intent

- `confidence` — mark LLM-generated or unverified facts as `low` (tracks compounding hallucination)
- `code_refs` / `commits` — the basis for code-doc sync lint (repo-only)
- `status: superseded` + `superseded_by` — preserve ADR immutability (never delete a past decision, only mark it superseded). The lint requires `superseded_by` when `status: superseded`.
- `status: archived` — kept for history, no longer acted on (e.g. an executed superpowers plan)

## What `yarn docs:lint` checks

- Every `docs/**/*.md` (except `docs/prototype/`) has frontmatter with the required keys, valid `type` / `status` / `confidence`, and `YYYY-MM-DD` dates
- No keys outside this page (common, optional, and the type's additional fields)
- `related`, `implements`, `supersedes`, `superseded_by` point to files that exist (relative to the document)
- `code_refs` paths exist (relative to the repo root)
- Relative markdown links in the body resolve (links inside code are ignored)
- Every ADR is linked from `../index.md` and `../adr/README.md`
