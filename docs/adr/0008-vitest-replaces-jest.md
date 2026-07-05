---
title: "ADR 0008: vitest replaces jest (amends 0005/0007)"
type: adr
status: accepted
created: 2026-07-06
updated: 2026-07-06
confidence: high
owner: andrea
tags: [adr, testing, vitest, stack]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ./0007-pglite-testing-and-local-lint-base.md
---

# ADR 0008: vitest replaces jest (amends 0005/0007)

## Status

Accepted. Amends [ADR 0005](./0005-tech-stack-vercel-native-next-fullstack.md)'s test-runner row (Jest + ts-jest); the pglite decision in [ADR 0007](./0007-pglite-testing-and-local-lint-base.md) is unchanged.

## Context

Jest's ESM support is officially experimental: every run needed `NODE_OPTIONS=--experimental-vm-modules` (with its warning noise), transforms went through ts-jest, and `unstable_mockModule` cannot re-bind module mocks per test (jest/jest#13448) — which kept module mocking off the table entirely. The suite itself uses no `jest.*` APIs (mocks were rejected by design; tests run real classes over pglite), so the runner was replaceable at near-zero cost.

## Decision

**Backend tests run on vitest** (`vitest run`, zero config file — defaults suffice; the `forks` pool runs pglite WASM fine). Test files import `describe/it/expect/…` explicitly from `vitest` instead of relying on injected globals. jest, ts-jest, and @types/jest are removed.

## Consequences

- Native ESM: no experimental flags; esbuild transform instead of ts-jest; test files run in parallel, and the wall-time gap grows with the suite.
- Module mocking (`vi.mock`) is now technically possible per test — but constructor injection stays the seam: explicit provider arguments beat hoisted module-graph swaps. The DI design was never only a jest workaround (rule: AGENTS.md's no-test-seams bullet, which lands with the service-layer PR).
- Branches carrying test files written for jest globals convert by adding one explicit `import { … } from 'vitest'` line per file.
- Future frontend component tests get the natural vitest + testing-library pairing; one runner across workspaces.
- 0005's test row now reads: superseded by 0007 (pglite) + 0008 (vitest).
