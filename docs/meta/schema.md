---
title: Frontmatter schema
type: meta
status: active
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
tags: [meta, schema]
related:
  - ./conventions.md
  - ../README.md
---

# Frontmatter schema

Every document has YAML frontmatter. 7 required keys + type-specific optional keys.

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
tags: []
related: []                         # array of relative-path links
---
```

## Additional fields per type

| type | Additional fields |
|---|---|
| `adr` | `decision_date`, `supersedes` / `superseded_by`, `stakeholders` |
| `journal` | `session`, `commits: [sha…]` |
| `spec` | `phase`, `target_date`, `implements` (related ADR path) |
| `reference` | `code_refs: [src/…]` (corresponding source path — for stale detection when code changes) |

## Design intent

- `confidence` — mark LLM-generated or unverified facts as `low` (tracks compounding hallucination)
- `code_refs` / `commits` — the basis for code-doc sync lint (repo-only)
- `status: superseded` + `superseded_by` — preserve ADR immutability (never delete a past decision, only mark it superseded)
