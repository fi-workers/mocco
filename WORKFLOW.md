---
# Agent orchestration rules (Symphony SPEC style).
# Operating guide: docs/guides/agent-orchestration.md · runner: scripts/agents/orchestrator.mjs
# The runner reads this file from origin/main, so changes take effect only after they merge.
name: Mocco
tracker:
  kind: github-labels
  repo: fi-workers/mocco
  active_states: [agent:rework, agent:ready]
  wait_states: [agent:human-review, agent:blocked]
  claimed_state: agent:in-progress
  terminal: issue_closed
workspace:
  # One worktree per issue (<root>/issue-<number>, branch agent/<number>)
  root: ~/agent-workspaces/mocco
hooks:
  after_create: yarn install --immutable
  before_run: git fetch origin main && git merge --no-edit origin/main
agent:
  max_concurrent_agents: 1
  max_issues_per_run: 1
  max_attempts: 3
  max_verify_attempts: 3
  max_budget_usd: 15
  timeout_minutes: 120
  # This repo lands PRs sequentially: pick no new issue while an agent PR is open
  sequential: true
verify:
  # The orchestrator's independent check after the agent opens its PR.
  # yarn verify is the same CI mirror pre-push enforces; docs:lint runs first because it is fast.
  always: [yarn docs:lint, yarn verify]
wiki:
  index: docs/index.md
# Sentry triage is off: only the frontend has Sentry, and no production DSN is confirmed.
# To turn it on later, copy scripts/agents/prompts/sentry-triage.md from fi-workers/showyourtime, adapt it,
# and add:
# sentry:
#   prompt: scripts/agents/prompts/sentry-triage.md
#   project: <org>/<project>
#   period: 7d
#   max_new_issues: 3
#   max_budget_usd: 3
#   timeout_minutes: 30
---

You are the agent working on GitHub issue #{{ issue.number }} in the Mocco repository (fi-workers/mocco).
Attempt: {{ attempt }}

## Issue

Title: {{ issue.title }}

{{ issue.body }}

## Before you start

1. Read `AGENTS.md`, then `docs/README.md` and `docs/index.md`. Open the docs related to this issue before reading code.
   `AGENTS.md` and the `/pr` skill (`.claude/skills/pr/SKILL.md`) are the rules; this prompt only adds what is specific
   to running unattended. Where they conflict, they win, except that you never merge and never wait for a human reply.
2. If the issue body links a superpowers spec or plan (`docs/superpowers/specs/…`, `docs/superpowers/plans/…`), that
   document is the spec. Follow the plan task by task and keep to its scope boundary.
3. If the issue has no acceptance criteria, or it can be read two or more ways, do not implement anything. Leave a
   comment on the issue with your questions, change the label to `agent:blocked`, and stop.
4. If this attempt started from `agent:rework`, read the review comments on the existing PR first and fix only those.

## Work

- Use branch `agent/{{ issue.number }}`, based on `origin/main`. Never commit to `main`.
- One concern, minimal diff. Note unrelated problems in the PR body instead of fixing them.
- All content in English: code, comments, docs, commit messages, PR bodies.
- Pin dependencies exactly. Stage explicit paths only (never `git add -A` / `git add .`), and check that
  `git status --porcelain` is empty after committing.
- Commit messages use a conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`) and end with exactly one
  `Co-Authored-By: Claude <model name> <noreply@anthropic.com>` line. Never add session URLs or `Claude-Session:`
  trailers, in commits or in the PR body.

## Verification gate

When the implementation is done, change the label to `agent:verifying` and make `yarn verify` pass (it is the CI
mirror, and pre-push runs it too). If a check fails, fix it and run it again. If it still fails after
{{ agent.max_verify_attempts }} attempts, change the label to `agent:blocked` and post the failing output as an issue
comment.

## Docs (the wiki)

- If behavior changed, update the matching `docs/reference/` page in the same PR. ADR bodies are immutable; a
  reversal is a new ADR.
- Record what you learned (structure, pitfalls, decisions) in the right doc, following `docs/meta/schema.md` and
  `docs/meta/conventions.md`. When you change any doc, add an entry to `docs/log.md`. Run `yarn docs:lint`.
- If you find code and docs that disagree, say so in the PR body. Fix the doc only when this issue is about it.

## Feedback promotion

If the issue or a review comment states a rule that will apply to future PRs, promote it to the strongest layer
(lint rule > test > `AGENTS.md` > skill/docs) as the `/pr` skill describes, and list it in the PR body as
`Promoted rules: …`.

## Finish

Push the branch, open a PR with `gh pr create --base main`, and change the issue label to `agent:human-review`.
The PR title is the commit subject. The body uses the `/pr` skill shape:

```markdown
Closes #{{ issue.number }}

## Summary

<what changed, 2-6 bullets; say what is intentionally not here>

## Why

<the problem, the benefit, why this approach over the alternatives, the trade-offs>

## Verified

<actual results: yarn verify, test counts, anything you could not verify and why>
```

Do not merge the PR, close the issue, or push to `main`. A human reviews and merges.
