---
name: pr
description: Ship one small, review-ready PR the Mocco way — one concern, green harness, English-only, house commit/PR format. Use when starting a new slice of work or when asked to "make a PR" / "다음 PR".
---

# Mocco PR workflow

Ship exactly **one concern per PR**, in dependency order, always green. The reviewer merges; you never merge or push to `main`.

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
   - **Stage explicit paths only — never `git add -A`/`git add .`.** The shared working tree can contain unrelated files (other sessions' notes, scratch work); a blanket add once swept a foreign research note into a public PR and required a history rewrite.

## Verify (all must pass — run them, don't assume)

```bash
yarn install            # clean, no lockfile drift
yarn lint               # backend + frontend, --max-warnings 0
yarn backend ts-check && yarn frontend ts-check
yarn test               # jest incl. pglite integration
yarn frontend build     # when frontend changed
```

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

   ## Verified

   <the actual harness results: test counts, build, lint>
   ```
   Title = the commit subject. Keep PR bodies free of session links too.
8. Tell the user the PR URL and wait for their review/merge signal before starting the next slice.

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
