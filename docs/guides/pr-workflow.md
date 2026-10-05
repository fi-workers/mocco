---
title: PR workflow
description: How changes land in the repo — one concern per PR, sequential landing on fresh main, and the green-and-installable checks every PR must pass.
type: guide
status: active
created: 2026-07-04
updated: 2026-10-06
confidence: high
owner: andrea
tags: [guide, pr, workflow, process]
---

# PR workflow

> How changes land in this repo — for humans and agents alike. Agents get the executable version as the `/pr` skill (`.claude/skills/pr/SKILL.md`).

## Principles

- **One concern per PR**, in dependency order. Small enough to actually review — the reviewer is the safety mechanism, not a rubber stamp.
- **Sequential landing.** The next slice starts from fresh `main` after the previous PR merges. No long-lived stacks.
- **Every PR is green and installable on a fresh clone**: format (`yarn format:check`), docs lint (`yarn docs:lint`), lint (`--max-warnings 0`), ts-check, tests (pglite, docker-free), migration drift (schema.ts ↔ committed migrations), frontend build, `yarn install` without lockfile drift — the same set CI enforces (`.github/workflows/ci.yml`).
- **`main` is never pushed directly** — everything goes through a PR, reviewed and merged by a maintainer.

## House rules enforced per PR

| Rule | Why |
|---|---|
| English only (code, comments, docs, commits) | public OSS |
| Dependencies pinned exactly; lockfile matches the branch's workspaces | supply-chain + reviewable dep changes |
| One drizzle migration per schema change, in PR order | migration history mirrors product history |
| Vendors behind neutral wrappers (env names ours, one import site) | replaceability (see `packages/backend/src/domain/auth/`) |
| Behavior changes update `docs/reference/` in the same PR | wiki stays truthful |
| No session links in commits/PRs; `Co-Authored-By` attribution stays | clean public history |

## Pre-push on a shared machine

The husky pre-push hook runs the whole `yarn verify`, including every backend test; its scope doesn't shrink to the diff. Several agent sessions often share one machine, so the backend suite has to pass at a high load average (#420).

- The suite migrates one PGlite per run: a global setup (`packages/backend/src/infra/db/testing/pglite-global-setup.ts`) applies the real migrations once and writes the data directory to a temp file. `createTestDb()` then boots each test's database from that copy. The schema is the same, and each `beforeEach` costs about a fifth of the CPU it took when every test ran all the migrations itself.
- The per-test and per-hook timeouts stay at 30 s, and CI runs the same config in three shards. The one exception is the 1500-delivery run in `delivery-capacity.test.ts`. It runs on an injected clock, so its 20-minute timeout only catches a hang; in a full suite on a loaded machine it took 500 s.
- If a backend test still times out locally under load, rerun `yarn verify`. Don't push with `--no-verify`. A test that fails twice is a real failure, or a test that depends on the wall clock; fix it with the injected clock the domain already takes.

## Cadence

1. Agent builds the slice on a `feat/…` / `chore/…` / `docs/…` / `ci/…` branch, runs the full harness, opens the PR with a Summary + Verified body.
2. Maintainer reviews and merges (any merge strategy).
3. **Feedback auto-promotion**: any rule-worthy review feedback is promoted by the agent, in the same session, to the strongest enforcing layer — lint rule > test > AGENTS.md > skill/docs — and announced in the PR. The process learns without anyone having to remember.

See also: [AGENTS.md](../../AGENTS.md) · [frontend conventions](../reference/frontend-conventions.md) · [CI conventions](../reference/ci-conventions.md)
