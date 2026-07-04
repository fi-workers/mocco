---
title: Mocco Wiki — Top-level MOC
type: overview
status: active
created: 2026-06-30
updated: 2026-07-04
confidence: high
owner: andrea
tags: [index, moc]
related:
  - ./README.md
---

# Mocco Wiki — Top-level MOC

> Deploy governance control plane on top of GitHub Actions. Long term, a unified ops control plane.
> For usage, see the [README](./README.md).

## Product core

- **Reason to exist:** even with GitHub write permission, block deploys for anyone without production deploy permission.
- **Core model:** pipelines pause at **gates**; only authorized roles resume them, and **credential gating** (OIDC/STS) makes bypass impossible. Executor-agnostic — GitHub Actions is the first adapter (ADR 0003/0004).

## Decisions (ADR)

- [ADR index](./adr/README.md)
- [0001 — Name the product Mocco](./adr/0001-name-the-product-mocco.md)
- [0002 — Mocco is an independent authorization layer](./adr/0002-mocco-is-an-independent-authorization-layer.md)
- [0007 — pglite tests, local lint base (amends 0005)](./adr/0007-pglite-testing-and-local-lint-base.md)

## Implementation

- `src/` — the actual code monorepo (ADR 0005 stack). `@mocco/{frontend,backend}` (`common` returns with the governance domain)

## Guides

- [Local development setup](./guides/local-setup.md) — local domains, env, auth setup
- [PR workflow](./guides/pr-workflow.md) — one concern per PR, review pipeline, feedback promotion

## Concepts

- [Authorization model and wedge](./concepts/authorization-and-wedge.md) — **why Mocco is an independent authorization layer unrelated to GitHub** (headline identity)
- [Glossary](./concepts/glossary.md) — clarifying confusing terms: pipeline / workflow / run / deploy, etc.

## Specs · Reference

- [Feature map — MVP scope](./reference/feature-map.md) — MVP vs Post-MVP
- [Prototype scope & IA](./specs/2026-06-30-prototype-scope.md) — click-through screen definitions ([prototype itself](./prototype/README.md))
- [Workspace model](./reference/workspace.md) — tables, invariants, contracts, known gaps
- [Frontend conventions](./reference/frontend-conventions.md) — RSC-first, adopted 2026 patterns, lint stack
- [CI conventions](./reference/ci-conventions.md) — supply-chain hardening rules
- [DB conventions (Drizzle)](./reference/db-conventions.md) — mocco_ prefix, id, timestamp, indexes
- [.mocco.yml file format spec](./reference/mocco-yml-spec.md) + [JSON Schema](./reference/mocco.schema.json) — pipeline + gate definitions (draft v1)

## Meta

- [frontmatter schema](./meta/schema.md) · [conventions](./meta/conventions.md) · [meta changelog](./meta/changelog.md)
