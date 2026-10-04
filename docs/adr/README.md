---
title: ADR Index
description: Chronological index of all architecture decision records with their status and dates.
type: overview
status: active
created: 2026-06-30
updated: 2026-09-25
confidence: high
owner: andrea
tags: [adr, index]
related:
  - ../index.md
---

# ADR Index

| # | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-name-the-product-mocco.md) | Name the product Mocco | accepted | 2026-06-30 |
| [0002](./0002-mocco-is-an-independent-authorization-layer.md) | Mocco is an independent authorization layer (separate from GitHub, only identifiers sync) | accepted | 2026-06-30 |
| [0003](./0003-core-model-is-pause-resume-gates-no-env.md) | Core model = pause/resume gates, drop env (role-based resume) | accepted | 2026-06-30 |
| [0004](./0004-executor-agnostic-core-with-adapter-contract.md) | Executor-agnostic core + adapter contract (trigger + callback + credentials) | accepted | 2026-06-30 |
| [0005](./0005-tech-stack-vercel-native-next-fullstack.md) | Tech stack = Vercel-native Next full stack (yarn4, Drizzle, Better Auth) | accepted | 2026-07-01 |
| [0006](./0006-domains-mocco-club-prod-mocco-work-local.md) | Domains — prod mocco.club, local mocco.work | accepted | 2026-07-01 |
| [0007](./0007-pglite-testing-and-local-lint-base.md) | pglite for tests, local lint base (amends 0005) | accepted | 2026-07-04 |
| [0008](./0008-vitest-replaces-jest.md) | vitest replaces jest (amends 0005/0007) | accepted | 2026-07-06 |
| [0009](./0009-frontend-uses-the-pages-router.md) | Frontend uses the Pages Router | accepted | 2026-07-11 |
| [0010](./0010-mocco-yml-lean-core-and-enforcement-invariants.md) | `.mocco.yml` stays a lean governance file; enforcement invariants are broker-side | accepted | 2026-07-12 |
| [0011](./0011-external-api-surface-architecture.md) | External API surface — Hono on the App Router | accepted | 2026-07-14 |
| [0012](./0012-repository-per-table-for-db-owning-domains.md) | Repository per table for DB-owning domains | accepted | 2026-07-15 |
| [0013](./0013-mocco-is-a-multi-product-platform.md) | Mocco is a multi-product platform — projects below workspaces, per-workspace product enablement | draft | 2026-09-25 |
| [0014](./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md) | Background jobs on a Postgres job table driven by a tick | draft | 2026-09-25 |
| [0015](./0015-public-sites-use-isr-on-the-pages-router.md) | Public multi-tenant sites use ISR on the Pages Router | draft | 2026-10-02 |
| [0017](./0017-public-v1-api-keys-and-sdk-licensing.md) | Public /v1 API, publishable and secret keys, and MIT SDKs | draft | 2026-10-01 |
| [0018](./0018-domain-events-vs-audit-log.md) | Domain events are separate from the audit log | draft | 2026-09-25 |
| [0019](./0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md) | Inbound webhooks use per-source ingest URLs with mandatory signatures | draft | 2026-09-25 |
| [0020](./0020-approvals-outside-pipeline-runs.md) | Approvals outside pipeline runs | draft | 2026-10-01 |
| [0021](./0021-ota-client-is-expo-updates-protocol-v1.md) | The OTA client contract is the Expo Updates protocol v1 | draft | 2026-10-01 |
| [0022](./0022-ota-signing-key-stays-in-ci.md) | OTA code signing: the key stays in CI, rollbacks are pre-signed | draft | 2026-10-01 |
| [0023](./0023-flag-targets-are-evaluation-scopes.md) | Flag targets are evaluation scopes, not governance types | draft | 2026-10-02 |
| [0024](./0024-flags-openfeature-flagd-ruleset-ofrep.md) | Flags: OpenFeature-first, flagd ruleset, OFREP, one-way kill switch, MIT SDKs | draft | 2026-10-02 |
| [0025](./0025-every-product-surface-ships-mcp-tools.md) | Every product surface ships MCP tools: thin adapters, caller identity, decisions need a person | draft | 2026-10-02 |
| [0026](./0026-position-mocco-around-the-production-record.md) | Position Mocco around the production record, with products grouped by job | superseded by 0027 | 2026-10-04 |
| [0027](./0027-mocco-is-everything-a-product-needs-except-the-code.md) | Mocco is everything a product needs, except the code | draft | 2026-10-04 |

0015–0017 are reserved for the decisions named in the [platform foundations design](../specs/2026-09-24-platform-foundations-design.md) §21 (public sites, end-user identity, public API) and are written with their slices.

> Add new decisions as `{NNNN}-{imperative-kebab}.md`. Reversals become a new ADR + `superseded_by` on the old one. No after-the-fact edits to the body.
