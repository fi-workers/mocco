---
title: Agent orchestration (GitHub issues → unattended agent → PR)
description: How the issue-driven agent orchestrator works in this repo — WORKFLOW.md, the agent:* label states, linking an issue to a superpowers spec or plan, the commands, the sequential-landing rule, and the safety limits.
type: guide
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: high
owner: andrea
tags: [guide, agents, orchestration, workflow, process]
related:
  - ./pr-workflow.md
  - ../README.md
  - ../log.md
---

# Agent orchestration

GitHub issues are the work queue. A human writes the spec and labels the issue `agent:ready`; the orchestrator picks
it up, runs `claude -p` in a dedicated worktree, reruns the verification gate itself, and leaves a PR for review.
Humans only write specs and review or merge PRs. Nothing is merged or deployed automatically.

The design follows the [OpenAI Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md), reduced to
GitHub labels, and was first built in `fi-workers/showyourtime`. The runner has no repo-specific code: everything
specific to Mocco is in the front matter of [`WORKFLOW.md`](../../WORKFLOW.md), and the body of that file is the prompt
the agent receives.

| File | Role |
| --- | --- |
| [`WORKFLOW.md`](../../WORKFLOW.md) | Config (front matter) and the agent prompt template (body) |
| [`scripts/agents/orchestrator.mjs`](../../scripts/agents/orchestrator.mjs) | The runner (Node, no dependencies; calls `git`, `gh`, `claude`) |
| [`scripts/setup-agent-labels.sh`](../../scripts/setup-agent-labels.sh) | Creates the `agent:*` labels |
| [`scripts/agents/install-launchd.sh`](../../scripts/agents/install-launchd.sh) | Optional daily run on macOS |
| [`.github/ISSUE_TEMPLATE/agent-task.yml`](../../.github/ISSUE_TEMPLATE/agent-task.yml) | Issue form for agent-ready work |

## Label states

An issue carries at most one `agent:` label. Issues without one are ignored.

| Label | Meaning | Set by |
| --- | --- | --- |
| `agent:ready` | The spec is complete; an agent may pick it up | human |
| `agent:in-progress` | An agent is working on it | orchestrator |
| `agent:verifying` | Implementation done; the verification gate is running | agent |
| `agent:human-review` | A PR is open and waits for review | agent, confirmed by the orchestrator |
| `agent:blocked` | Stopped: missing spec, failed gate, or too many attempts. See the issue comments | agent or orchestrator |
| `agent:rework` | The review asked for changes; the agent works on the same branch again | human, or the orchestrator when its own check fails |

`agent:ready` and `agent:rework` are the active states. When a blocked issue has been answered, a human moves it back
to `agent:ready`. Closing the issue ends the flow.

## Writing an issue for an agent

Use the **Agent task** issue template. It asks for the goal, acceptance criteria, verification, out-of-scope items,
and references. The agent refuses to implement (and moves the issue to `agent:blocked` with questions) when the
acceptance criteria are missing or ambiguous, so the spec is the part a human must get right.

Most work in this repo is designed as a superpowers spec and plan under `docs/superpowers/`. To hand one to an agent:

1. Merge the spec and plan first (the agent reads them from `main`).
2. Open an issue with the template and put the plan path in **Spec or plan**, e.g.
   `docs/superpowers/plans/2026-07-20-slice3b-commit-sync.md`. The prompt tells the agent to follow a linked plan task
   by task and to keep to its scope boundary.
3. Keep one issue per PR-sized slice. If a plan says "this is one PR", that is one issue; if a plan covers several
   PRs, open one issue per PR and say in each which tasks it covers.
4. Label it `agent:ready`.

## Commands

The runner always reads `WORKFLOW.md` from `origin/main` (or `--ref`), so rule changes go through a normal PR.

| Command | What it does |
| --- | --- |
| `node scripts/agents/orchestrator.mjs work` | Process `agent:rework`, then `agent:ready` issues, up to `agent.max_issues_per_run` (1) |
| `node scripts/agents/orchestrator.mjs work --issue 12` | Process that one issue, whatever its label |
| `node scripts/agents/orchestrator.mjs work --ref <branch>` | Use `WORKFLOW.md` from another branch (to test rule changes before merging) |
| `node scripts/agents/orchestrator.mjs daily` | What launchd runs; the same as `work` here because Sentry triage is off |
| `scripts/setup-agent-labels.sh` | Create or update the labels (also creates a `sentry` label, unused here) |
| `scripts/agents/install-launchd.sh [hour minute]` | Run `daily` every day (default 08:00); `--uninstall` removes it |

Workspaces live under `~/agent-workspaces/mocco/` (`issue-<number>` per issue, `control` for launchd). Logs, including
the full `claude` stream per run, go to `~/Library/Logs/agents/mocco/`.

## Sequential landing

This repo lands PRs one at a time (see the [PR workflow](./pr-workflow.md)). `WORKFLOW.md` sets
`agent.sequential: true`, so the orchestrator picks no new issue while any PR from an `agent/` branch is open, and
`agent.max_issues_per_run: 1`. The next issue starts only after a human merges or closes the open agent PR, and it
starts from fresh `origin/main` (`hooks.before_run` merges `origin/main` into the issue branch).

Human PRs do not stop the orchestrator. If you are landing a human slice, do not label the next issue `agent:ready`
until it merges.

## Verification

The agent must make `yarn verify` pass before opening its PR (pre-push enforces it anyway). After the PR is open, the
orchestrator reruns `verify.always` from `WORKFLOW.md` (`yarn docs:lint`, then `yarn verify`) in the worktree. If
that fails, the issue goes to `agent:rework`, the failure is posted on the PR, and the next run fixes it. If it
passes, the orchestrator comments the result on the PR and leaves it in `agent:human-review`.

## Safety limits

- **Permissions**: the agent runs with `--permission-mode acceptEdits` and cannot force-push, push to `main`, merge
  PRs, close or delete issues, or run `gh repo` / `gh release`.
- **Budget**: at most $15 and 120 minutes per agent run (`agent.max_budget_usd`, `agent.timeout_minutes`).
- **Attempts**: at most 3 runs per issue (`agent.max_attempts`), counted from the `agent-run` marker comments. After
  that the issue goes to `agent:blocked`. Delete those comments to reset the count.
- **Recovery**: an issue left in `agent:in-progress` by a run that died is returned to `agent:ready` on the next run.
- **One at a time**: a lock file in the workspace root allows a single run.
- **Rules from `main` only**: config and prompt are read from `origin/main`, so an agent cannot change its own rules
  in the branch it is working on.
- **English and attribution**: the prompt repeats the repo rules — English only, one `Co-Authored-By` line, no session
  links or `Claude-Session:` trailers.

## Not enabled yet

- **Labels** are not created; run `scripts/setup-agent-labels.sh` once before the first pilot.
- **Daily launchd run** is not installed. Start by running `work --issue <number>` by hand on a small issue.
- **Sentry triage** is off: only the frontend has Sentry and no production DSN is confirmed. `WORKFLOW.md` shows the
  section to add once it is.
