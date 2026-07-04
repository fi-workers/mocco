---
title: Mocco is an independent authorization layer — separate from GitHub, only identifiers sync
type: adr
status: accepted
created: 2026-06-30
updated: 2026-06-30
confidence: high
owner: andrea
decision_date: 2026-06-30
supersedes:
stakeholders: [andrea]
tags: [adr, authorization, positioning, wedge]
related:
  - ./0001-name-the-product-mocco.md
  - ../concepts/authorization-and-wedge.md
---

# ADR 0002 — Mocco is an independent authorization layer

## Context

The original plan and early prototype framed the wedge as *"GitHub required reviewers are Enterprise-only on private repos → cheaply replace that paywall."* The owner pushed back: **required reviewers are a GitHub feature, not ours.** That framing wrongly makes our reason to exist depend on GitHub's features and pricing policy.

Key insight (owner): "Mocco is **separate permission management** that has nothing to do with GitHub. It can sync with GitHub later, but it must be **kept separate and synced.**"

## Decision

**Mocco is the independent source of truth for deploy and approval authorization.** Keep it separate from GitHub permissions.

**identity ↔ authorization separation:**

| Aspect | Owned by | Relation to GitHub |
|---|---|---|
| **authorization** (who can approve/deploy) | **Mocco** (its own roles and policies) | **Independent** of GitHub write/admin. Not derived from GitHub permissions |
| **identity** (which GitHub actor someone is) | **Linked** from GitHub | For self-approval checks and audit. Verified identifiers only |
| **sync** (optional) | Mocco pulls it in | **One-way GitHub→Mocco, opt-in** (e.g., convenience mapping `@sre` team → `deployer:production`) |

- **Standalone by default.** Even with sync turned off, Mocco is self-contained.
- **Guardrails (never do this):** GitHub write/admin ⇒ auto-granting Mocco permissions / repo admins bypassing policy / granting permissions to unverified identifiers.

## Consequences

- **Headline wedge change:** "avoiding the Enterprise paywall" (secondary) → **"independent deploy permission management unrelated to GitHub"** (primary). "write ≠ deploy" is a *result* of that.
- The data model needs a **Mocco-native principal/role store** (users, teams, per-env roles). GitHub identifiers are link fields.
- Add an **Access (permissions) screen** to the prototype — visualize the wedge with a member who is a GitHub admin but has zero Mocco permissions (Doyun).
- C7 (re-validating Enterprise pricing) is **resolved out of the product justification** — our value does not hinge on GitHub pricing. required reviewers availability is now only competitive intel.

## Reversal Conditions

- If customers overwhelmingly demand "we want to use GitHub permissions as-is (separate management is a burden)," keep the independent model as the default but consider adding a "mirror GitHub permissions" mode as an option (Mocco still owns authorization).
