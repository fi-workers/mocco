---
title: A feedback board ships posts on the release registry's releases, narrowed per board — no environments
description: Shipping a feedback post on deploy needs to know which run put code in front of users. Mocco has no environments (ADR 0003), so a board names the repo whose releases count and, optionally, a step the release's run must have succeeded; a release is the registry's deploy.released (a succeeded run that passed a resumed gate). A `.mocco.yml` release marker was considered and left out.
type: adr
status: draft
created: 2026-10-17
updated: 2026-10-17
confidence: medium
owner: andrea
decision_date: 2026-10-17
stakeholders: [andrea]
tags: [adr, feedback, releases, governance]
related:
  - ./0003-core-model-is-pause-resume-gates-no-env.md
  - ./0010-mocco-yml-lean-core-and-enforcement-invariants.md
  - ./0018-domain-events-vs-audit-log.md
  - ../specs/2026-09-24-feedback-design.md
  - ../reference/feedback.md
  - ../reference/releases.md
---

# ADR 0031 — A feedback board ships posts on the release registry's releases, narrowed per board

## Context

The feedback board's headline feature (#179) marks a post shipped when the pull requests linked to it are live. "Live"
means "in a commit that a run deployed to production". ADR 0003 removed environments, so Mocco can't ask which runs
went to production; something has to stand in for it.

The [feedback design](../specs/2026-09-24-feedback-design.md) §5.3 proposed a per-board setting: the repo whose runs
count, and optionally a step name the run must have succeeded, with "any succeeded run on the watched branch" when no
step is named. It left the ADR open, alongside a `.mocco.yml` alternative (a `release: true` marker on a step).

Since then the release registry (#155, [releases](../reference/releases.md)) has given "production deploy" one meaning
across Mocco: a run that succeeded **and passed at least one resumed gate** is a release, recorded once per linked
project and announced once as `deploy.released`, with an hourly reconcile for events the bus missed. The status deploy
watch already starts from it.

## Decision

1. **A board ships on releases, not on every succeeded run.** The ship detector subscribes to `deploy.released`. A run
   that never paused at a gate (a CI run, a preview deploy) can't mark a post shipped. This keeps one definition of a
   production deploy across products, and it means a suggestion can always say who approved the release ("approved by
   sre"), which is what makes it trustworthy enough to email voters on.
2. **The board narrows which releases count.** `release_repo_id` names the repo (one linked to the board's project; the
   release must name that project). `release_step_name`, when set, requires the run to have succeeded a step of that
   name; `deploy.released` gained `succeededSteps` for it. One repo per board, as the design's v1.
3. **A step name is a label, as ADR 0003 says.** No `.mocco.yml` marker: the file stays the lean governance file of ADR
   0010, and the board's owner (who may not own the pipeline) can set the policy without a commit.
4. **Ancestry, not commit order.** A link ships when its merge commit is the released commit or GitHub's compare API says
   the release contains it. `mocco_commits.seq` is not trusted for this: a force-push makes it lie.
5. **Suggest by default.** A board asks the team (`ship_mode = suggest`) unless its owner turns on `auto_apply`, which
   marks posts shipped as no one (reason `auto_apply`); changing the policy is audited.

## Consequences

- A team whose production pipeline has no gate gets no suggestions. That is deliberate (point 1) and the docs say so; a
  pipeline can add a gate, and staff can still mark posts shipped by hand.
- Posts whose work lands in another repo than the board's release repo (a monorepo split, a mobile app shipped from its
  own repo) don't ship under `all_links_shipped` until those links ship some other way. Several release repos per
  board is a later change of the setting, not of this decision.
- Reverts and rollbacks aren't detected: a link records the first release that contained it and keeps it.
- A `.mocco.yml` marker can still come later if teams want the pipeline to own the definition; it would be a new ADR
  superseding point 3.
