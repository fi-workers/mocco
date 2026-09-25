---
title: Mocco Wiki — Top-level MOC
description: Top-level map of content for the Mocco wiki, linking the product core, ADRs, concepts, guides, references, and meta docs.
okf_version: "0.1"
type: overview
status: active
created: 2026-06-30
updated: 2026-09-25
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
- [0003 — Core model is pause/resume gates, no env](./adr/0003-core-model-is-pause-resume-gates-no-env.md)
- [0004 — Executor-agnostic core + adapter contract](./adr/0004-executor-agnostic-core-with-adapter-contract.md)
- [0005 — Tech stack: Vercel-native Next full stack](./adr/0005-tech-stack-vercel-native-next-fullstack.md)
- [0006 — Domains: prod mocco.club, local mocco.work](./adr/0006-domains-mocco-club-prod-mocco-work-local.md)
- [0007 — pglite tests, local lint base (amends 0005)](./adr/0007-pglite-testing-and-local-lint-base.md)
- [0008 — vitest replaces jest (amends 0005/0007)](./adr/0008-vitest-replaces-jest.md)
- [0009 — Frontend uses the Pages Router](./adr/0009-frontend-uses-the-pages-router.md)
- [0010 — `.mocco.yml` lean core; enforcement invariants are broker-side](./adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md)
- [0011 — External API surface: Hono on the App Router](./adr/0011-external-api-surface-architecture.md)
- [0012 — Repository per table for DB-owning domains](./adr/0012-repository-per-table-for-db-owning-domains.md)
- [0013 — Mocco is a multi-product platform (draft)](./adr/0013-mocco-is-a-multi-product-platform.md)
- [0014 — Background jobs on a Postgres job table driven by a tick (draft)](./adr/0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md)
- [0018 — Domain events are separate from the audit log (draft)](./adr/0018-domain-events-vs-audit-log.md)

## Implementation

- `packages/` — the code monorepo (ADR 0005 stack): `@mocco/{backend,frontend,common,e2e}`. Layout and commands: [AGENTS.md](../AGENTS.md)

## Guides

- [Local development setup](./guides/local-setup.md) — local domains, env, auth setup
- [PR workflow](./guides/pr-workflow.md) — one concern per PR, review pipeline, feedback promotion
- [Agent orchestration](./guides/agent-orchestration.md) — GitHub issues as the queue for unattended agents (`WORKFLOW.md`), labels, safety limits

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
- [Project model and product enablement](./reference/project.md) — projects, apps, repo links, product enablement, procedures for product routers
- [Background jobs and schedules](./reference/jobs.md) — adding a handler, retries and RetryAt, dedupe, schedules, the tick route and its env
- [Domain events](./reference/events.md) — the event catalog, publishing and subscribing, at-least-once delivery, retention
- [Backend conventions](./reference/backend-conventions.md) — domain / infra / transport layering, vendor isolation, per-router error mapping
- [Frontend conventions](./reference/frontend-conventions.md) — Pages Router, client-rendered, lint stack
- [Env management](./reference/env.md) — env file layout, `with-env`, `SERVICE_DOMAIN`, tailnet access
- [CI conventions](./reference/ci-conventions.md) — supply-chain hardening rules
- [DB conventions (Drizzle)](./reference/db-conventions.md) — mocco_ prefix, id, timestamp, indexes
- [.mocco.yml file format spec](./reference/mocco-yml-spec.md) + [JSON Schema](./reference/mocco.schema.json) — pipeline + gate definitions (draft v1)

## Superpowers specs and plans

Feature designs (`specs/`) and the task-by-task plans that executed them (`plans/`). Executed plans are `status: archived`.

- Specs
  - [E2b — Pipeline governance core (design & slice roadmap)](./superpowers/specs/2026-07-12-e2b-governance-roadmap-design.md)
  - [Slice 3 — GitHub integration (observation)](./superpowers/specs/2026-07-13-slice3-github-integration-observation-design.md)
  - [DB repository layer for table-owning domains](./superpowers/specs/2026-07-14-db-repository-layer-design.md)
  - [Env management — SERVICE_DOMAIN + with-env + tailnet generator](./superpowers/specs/2026-07-25-env-management-design.md)
  - [Slice 4 — Runs & the generic-executor live loop](./superpowers/specs/2026-07-26-slice4-runs-execution-design.md)
  - [Slice 5 — Gates & approval (pause / resume)](./superpowers/specs/2026-07-27-slice5-gates-approval-design.md)
  - [Slice 6 — GitHub Actions executor adapter](./superpowers/specs/2026-07-28-slice6-github-adapter-design.md)
  - [Slice 7 — Credential broker](./superpowers/specs/2026-07-29-slice7-credential-broker-design.md)
  - [Slice 8 — Audit log (per-workspace hash chain)](./superpowers/specs/2026-07-29-slice8-audit-log-design.md)
- Plans
  - [Slice 3a — GitHub Connect & Manage](./superpowers/plans/2026-07-14-slice3a-github-connect-manage.md)
  - [Backend `#backend` imports sweep](./superpowers/plans/2026-07-15-backend-hash-imports-sweep.md) (later replaced by `@backend/*`)
  - [DB repository layer refactor](./superpowers/plans/2026-07-15-db-repository-layer.md)
  - [Slice 3b — Commit sync](./superpowers/plans/2026-07-20-slice3b-commit-sync.md)
  - [Slice 3c — Config parse & commit detail](./superpowers/plans/2026-07-20-slice3c-config-detail.md)
  - [Env management](./superpowers/plans/2026-07-25-env-management.md)

## Meta

- [frontmatter schema](./meta/schema.md) · [conventions](./meta/conventions.md) · [meta changelog](./meta/changelog.md) · [log](./log.md)
