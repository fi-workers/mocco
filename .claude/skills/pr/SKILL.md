---
name: pr
description: Ship one small, review-ready PR the Mocco way — pre-PR senior team review, strengthened tests, green harness, house commit/PR format. Use when starting a new slice of work or when asked to "make a PR" / "다음 PR".
---

# Mocco PR workflow

Ship exactly **one concern per PR**, in dependency order, always green. The human reviewer merges; you never merge or push to `main`. After the PR is up, run the `/pr-review` skill for the post-PR loop.

## Before you branch

1. `git fetch origin` and check open PRs (`gh pr list`). If the previous slice is still open, **stop** — this repo lands PRs sequentially.
2. Confirm the next slice with the user if it isn't obvious from the plan (AGENTS.md → Key decisions, `docs/reference/feature-map.md`).

## Branch & build

3. Branch from `origin/main`: `feat/<slice>`, `chore/<slice>`, `docs/<slice>`, or `ci/<slice>`.
4. Keep the diff to the one concern. If you discover an unrelated fix, note it for its own PR.
5. House rules that MUST hold in the diff:
   - English only (code, comments, docs). Check: `grep -rlP '[\x{AC00}-\x{D7A3}]' <changed files>` → nothing.
   - Dependencies pinned exactly (no `^`/`~`); `yarn.lock` contains only workspaces that exist on the branch.
   - Each schema change ships its own drizzle migration (history tracks PR order).
   - New third-party services go behind a vendor-neutral wrapper (see `src/backend/auth/provider.ts`).
   - Behavior changes update the matching `docs/reference/` page in the same PR.

## Verify (all must pass — run them, don't assume)

```bash
yarn install            # clean, no lockfile drift
yarn lint               # backend + frontend, --max-warnings 0
yarn backend ts-check && yarn frontend ts-check
yarn test               # jest incl. pglite integration
yarn frontend build     # when frontend changed
```

## Pre-PR senior team review (before anything is pushed)

Spawn **five parallel subagents**, one per persona. Anti-rubber-stamp rules (grounded in 2026 multi-agent review practice):

- **Give each reviewer the raw diff (`git diff origin/main`) + repo docs pointers — never your own summary or intentions.** Trusting the implementer's framing is how rubber-stamping happens.
- Each prompt starts adversarially: _"Assume this diff contains problems. Your job is to find them, not to approve. If you truly find nothing in your domain, say so explicitly."_
- Reviewers run **independently in parallel** (no shared context — prevents groupthink).
- Required output shape per finding: `severity (blocker|major|minor) · file:line · issue · evidence · suggested fix · untested paths you noticed`.

| Persona                      | Lens                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Senior Product Planner**   | Does the change match the spec/ADRs/feature-map intent? Scope creep, missing acceptance criteria, naming & UX copy            |
| **Senior Backend Engineer**  | Correctness, authz/data boundaries, migrations, error paths, missing pglite coverage                                          |
| **Senior Frontend Engineer** | RSC/client boundaries, frontend-conventions.md compliance (no manual memo, named effects, URL-state), bundle, code-level a11y |
| **Senior Platform Engineer** | Architecture & coupling, vendor isolation, CI/supply-chain impact, performance, operability                                   |
| **Senior Designer**          | UI states (loading/error/empty), consistency, responsiveness, visual accessibility                                            |

Then triage:

1. **Adversarially verify every blocker/major** — challenge it against the actual code; demand evidence. Findings that don't survive are discarded (noise control). Minors are batched or dropped with a stated reason.
2. **Strengthen tests**: convert confirmed findings AND reviewer-flagged untested paths into new/extended tests — failure paths first (wrong input, unauthorized, empty states). This step is mandatory even when findings are zero: each reviewer's "untested paths" list must be answered with a test or a written reason.
3. Apply fixes, re-run the full harness.
4. **Loop cap**: if fixes were substantial, run one more panel round (max 2 rounds total or until a round yields zero confirmed blockers/majors).

## Commit & PR format

6. Commit message: conventional prefix, English, imperative. End with exactly:
   ```
   Co-Authored-By: Claude <model name> <noreply@anthropic.com>
   ```
   **Never include session URLs or `Claude-Session:` trailers.**
7. Push the branch, then `gh pr create --base main` with this body shape:
   ```markdown
   ## Summary

   <what this slice is, 2-6 bullets — say what's intentionally NOT here>

   ## Team review

   <N findings (X blocker / Y major / Z minor) → fixed / discarded-with-reason; tests added>

   ## Verified

   <the actual harness results: test counts, build, lint>
   ```
   Title = the commit subject. Keep PR bodies free of session links too.
8. **Hand off to `/pr-review`** for the post-PR loop, then tell the user the PR URL. Wait for their merge signal before the next slice.

## After merge

9. `git fetch origin` and start the next slice from fresh `origin/main` (no stacked branches across merges).

## Feedback promotion (automatic — do not skip)

Whenever the reviewer or user gives a correction, style preference, or "다시는 이러지 말자"-type note — during review or anywhere in the session — you MUST run this loop yourself, without being asked:

1. **Judge**: will this plausibly apply to future PRs (convention/preference/recurring mistake)? One-off contextual fixes don't qualify.
2. **Pick the strongest enforcing layer** that can hold the rule:
   1. **Lint rule** (machine-enforced — best) → eslint config
   2. **Test** (regression-proof) → jest/pglite
   3. **AGENTS.md** (every future agent session reads it)
   4. **This skill** (process rules) or `docs/reference/*` (domain conventions)
3. **Apply it in the same session**: small updates ride the current PR; otherwise an immediate follow-up commit/PR.
4. **Say what you promoted** in your reply and in the PR body (`Promoted rules: …`). Never promote silently, never drop feedback on memory alone.
