---
title: Mocco Wiki — Top-level MOC
description: Top-level map of content for the Mocco wiki, linking the product core, ADRs, concepts, guides, references, and meta docs.
okf_version: "0.1"
type: overview
status: active
created: 2026-06-30
updated: 2026-09-24
confidence: high
owner: andrea
tags: [index, moc]
related:
  - ./README.md
---

# Mocco Wiki — Top-level MOC

> All-in-one platform for developers. The first product line is deploy governance on top of GitHub Actions; the rest are on the [roadmap](./reference/roadmap.md).
> For usage, see the [README](./README.md).

## Product core — deploy governance (first product line)

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

## Roadmap · Research

- [Product roadmap](./reference/roadmap.md) — the product lines after deploy governance, their order, and the shared foundations
- [Platform foundations design](./specs/2026-09-24-platform-foundations-design.md) — project/app model, jobs, `/v1` + SDKs, public rendering, domains, identity layer, events
- Competitor research: [all-in-one platforms](./research/all-in-one-platforms-competitors.md) · [OTA](./research/ota-competitors.md) · [feature flags](./research/feature-flags-competitors.md) · [status page](./research/status-page-competitors.md) · [app reviews](./research/app-reviews-competitors.md) · [feedback](./research/feedback-competitors.md) · [identity](./research/identity-competitors.md) · [messenger](./research/messenger-competitors.md) · [help center](./research/help-center-competitors.md) · [forum](./research/forum-competitors.md) · [deep links](./research/deep-links-competitors.md)
- Product designs: [OTA](./specs/2026-09-24-ota-design.md) · [feature flags](./specs/2026-09-24-feature-flags-design.md) · [status page](./specs/2026-09-24-status-page-design.md) · [app reviews](./specs/2026-09-24-app-reviews-design.md) · [feedback](./specs/2026-09-24-feedback-design.md) · [identity](./specs/2026-09-24-identity-design.md) · [messenger](./specs/2026-09-24-messenger-design.md) · [help center](./specs/2026-09-24-help-center-design.md) · [forum](./specs/2026-09-24-forum-design.md) · [deep links](./specs/2026-09-24-deep-links-design.md)

## Specs · Reference

- [Feature map — MVP scope](./reference/feature-map.md) — deploy governance MVP vs Post-MVP
- [Prototype scope & IA](./specs/2026-06-30-prototype-scope.md) — click-through screen definitions ([prototype itself](./prototype/README.md))
- [Workspace model](./reference/workspace.md) — tables, invariants, contracts, known gaps
- [Frontend conventions](./reference/frontend-conventions.md) — RSC-first, adopted 2026 patterns, lint stack
- [CI conventions](./reference/ci-conventions.md) — supply-chain hardening rules
- [DB conventions (Drizzle)](./reference/db-conventions.md) — mocco_ prefix, id, timestamp, indexes
- [.mocco.yml file format spec](./reference/mocco-yml-spec.md) + [JSON Schema](./reference/mocco.schema.json) — pipeline + gate definitions (draft v1)

## Meta

- [frontmatter schema](./meta/schema.md) · [conventions](./meta/conventions.md) · [meta changelog](./meta/changelog.md)
