---
name: pr-review
description: Review an open Mocco PR with fresh-eyes agent reviewers, apply corrections on the PR branch, and loop until it is ready to merge. Use right after /pr posts a PR, or when asked to "review the PR" / "PR 리뷰".
---

# Mocco PR review & correction loop

Reviews a **posted** PR (default: the most recent open one; accept a PR number as argument), fixes what's confirmed, and ends by declaring merge-readiness. **Never merges** — the human does.

## 1. Fresh-eyes setup (redaction discipline)

- Fetch the diff with `gh pr diff <n>` and changed file list with `gh pr view <n> --json files`.
- Reviewers get **the diff + the repo's conventions docs only** — NOT the PR body, NOT commit messages, NOT anything the author (you) wrote about intent. Fresh eyes judge the code, not the narrative.

## 2. Independent review panel (parallel, no shared context)

Three focused lenses (the heavy five-persona panel already ran pre-PR in `/pr`):

| Reviewer                       | Lens                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Correctness & Security**     | bugs, authz/data boundaries, error/edge paths, injection, secrets                                |
| **Conventions & Architecture** | AGENTS.md + frontend/ci-conventions compliance, vendor isolation, coupling, migration discipline |
| **Tests & UX**                 | do tests actually cover the changed behavior (esp. failure paths)? UI states, a11y               |

Each prompt starts adversarially: _"Assume problems exist; find them. Approving is not your job."_ Output shape: `severity (blocker|major|minor) · file:line · issue · evidence · suggested fix`.

## 3. Verify → correct (보정) → loop

1. **Adversarial verification**: challenge every blocker/major against the actual code — require concrete evidence (a failing scenario, a violated rule). Unproven findings are discarded and listed as such. This is the noise gate; do not skip it.
2. Apply confirmed fixes as **new commits on the PR branch** (house commit format, no session links). Add/extend tests for every confirmed behavioral finding.
3. Re-run the full harness (install · lint · ts-check · test · build-if-frontend).
4. **Loop**: re-run the panel on the updated diff. Stop when a round yields **zero confirmed blocker/major findings**, or after **3 rounds** (then surface the remainder to the user instead of looping forever).

## 4. Declare readiness

When the loop converges:

- Update the PR body: append a `## Review loop` section — rounds run, findings confirmed/fixed/discarded, tests added.
- Post a PR comment: `Ready to merge ✅ — <n> rounds, <k> findings fixed, harness green.` (comment, not merge)
- Tell the user: **"머지 준비 완료"** with the PR URL and a 3-line summary of what changed since they last looked.

If the loop did NOT converge, say so plainly — list the unresolved findings and ask the user to decide. Never declare readiness that the evidence doesn't support.

## Rules that always apply

- Feedback promotion (see `/pr` skill): recurring findings become lint rules / tests / AGENTS.md lines in the same session.
- No fix without a confirmed finding; no finding survives without evidence.
- Cost sanity: reviewers read the diff, not the whole repo — point them at specific files only when a finding needs context.
