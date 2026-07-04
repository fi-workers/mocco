---
title: PR workflow
type: guide
status: active
created: 2026-07-04
updated: 2026-07-04
confidence: high
owner: andrea
tags: [guide, pr, workflow, process]
---

# PR workflow

> How changes land in this repo — for humans and agents alike. Agents get the executable version as the `/pr` skill (`.claude/skills/pr/SKILL.md`).

## Principles

- **One concern per PR**, in dependency order. Small enough to actually review — the reviewer is the safety mechanism, not a rubber stamp.
- **Sequential landing.** The next slice starts from fresh `main` after the previous PR merges. No long-lived stacks.
- **Every PR is green and installable on a fresh clone**: lint (`--max-warnings 0`), ts-check, tests (pglite, docker-free), frontend build, `yarn install` without lockfile drift.
- **`main` is never pushed directly** — everything goes through a PR, reviewed and merged by a maintainer.

## House rules enforced per PR

| Rule | Why |
|---|---|
| English only (code, comments, docs, commits) | public OSS |
| Dependencies pinned exactly; lockfile matches the branch's workspaces | supply-chain + reviewable dep changes |
| One drizzle migration per schema change, in PR order | migration history mirrors product history |
| Vendors behind neutral wrappers (env names ours, one import site) | replaceability (see `src/backend/auth/`) |
| Behavior changes update `docs/reference/` in the same PR | wiki stays truthful |
| No session links in commits/PRs; `Co-Authored-By` attribution stays | clean public history |

## Cadence

1. Agent builds the slice on a `feat/…` / `chore/…` / `docs/…` / `ci/…` branch and runs the full harness.
2. **Pre-PR senior team review** (`/pr` skill): five independent persona reviewers (product planner, backend, frontend, platform engineer, designer) read the raw diff — never the author's summary — and return severity-tagged findings. Blockers/majors are adversarially verified (evidence required, noise discarded), tests are strengthened for every confirmed finding and flagged untested path, then the PR is opened with a Team review section.
3. **Post-PR review loop** (`/pr-review` skill): three fresh-eyes reviewers (correctness+security / conventions+architecture / tests+UX) re-review the posted diff, confirmed findings are fixed as new commits, and the loop repeats until a round is clean (max 3) — then the agent posts "Ready to merge ✅" and reports **머지 준비 완료**.
4. Maintainer reviews and merges (any merge strategy). The agent never merges.
5. **Feedback auto-promotion**: any rule-worthy review feedback is promoted by the agent, in the same session, to the strongest enforcing layer — lint rule > test > AGENTS.md > skill/docs — and announced in the PR. The process learns without anyone having to remember.

See also: [AGENTS.md](../../AGENTS.md) · [frontend conventions](../reference/frontend-conventions.md) · [CI conventions](../reference/ci-conventions.md)
