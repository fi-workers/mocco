---
title: Authorization model and wedge — why Mocco is independent
type: concept
status: active
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
tags: [concept, authorization, wedge, positioning]
related:
  - ../adr/0002-mocco-is-an-independent-authorization-layer.md
---

# Authorization model and wedge — why Mocco is independent

## One-line identity

> **Mocco is an independent deploy authorization system unrelated to GitHub.** Mocco owns who can deploy and approve; GitHub only links identity. "GitHub write ≠ deploy" is a result of that independence.

## Why it must be independent

- **The GitHub permission model doesn't fit deploy governance.** write/admin is about "can you change the code," not "may you deploy to production." Coupling the two is dangerous.
- **We must not depend on GitHub's features and pricing.** required reviewers and environments belong to GitHub, and their plans/policies change. We don't tie our value to that.
- **Many repos and many environments, managed in one place.** Instead of GitHub settings scattered per repo, Mocco centrally owns principals, roles, and policies.

## identity vs authorization

- **authorization** = owned by Mocco. principals (people/bots), roles (approver/deployer), per-environment policy. **Not derived** from GitHub permissions.
- **identity** = linked from GitHub. Maps which Mocco principal the GitHub actor who triggered/committed the run is → used to block self-approval and for audit. Verified identifiers only.

## sync (optional, one-way)

- Standalone by default. Self-contained even with sync off.
- Optional: **GitHub → Mocco one-way, opt-in**.
  - identity bootstrap: pull in org members/teams to quickly create principals.
  - team→role mapping: conveniences like `@sre → deployer:production`.
- **Never done:** GitHub write/admin ⇒ auto-granting Mocco permissions / repo admins bypassing policy / reflecting Mocco→GitHub permissions back.

## Connection to enforcement

If independent authorization is the "declaration," what **makes it un-bypassable** is credential gating. A run not approved by a Mocco principal can't obtain OIDC STS, so the deploy itself is impossible. Independence of authorization + un-bypassable enforcement = the wedge.

## Competitive comparison (intel)

GitHub required reviewers / environments are **not the same category**. Native is a per-repo, per-environment gate (coupled to code permissions, configured per repo). Mocco is an **independent authorization control plane** above/beside that. Use native plan availability only to explain "how it differs from native," not as the basis of our wedge.
