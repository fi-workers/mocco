---
title: Domains — prod mocco.club, local mocco.work
type: adr
status: accepted
created: 2026-07-01
updated: 2026-07-01
confidence: high
owner: andrea
decision_date: 2026-07-01
stakeholders: [andrea]
tags: [adr, domain, infra]
related:
  - ./0001-name-the-product-mocco.md
  - ../guides/local-setup.md
---

# ADR 0006 — Domains: prod mocco.club, local mocco.work

## Context

`www.mocco.club` is currently the live landing page for the **old Mocco (workspace collaboration product)** (team collaboration, Google SSO). Just as we migrated the name, repo, and notes to the governance product, the domain was also occupied. Also, Mocco (governance) needs a stable public domain even for local development because of GitHub App **webhooks** and **OIDC callbacks**.

## Decision

- **Production = `mocco.club` / `www.mocco.club`** — **migrated** to the governance product. The old workspace landing is replaced (cleaned up separately).
- **Local dev = `mocco.work`** — the app runs at `dev.mocco.work` (leaving room for `stg.`, etc. later). Exposed via **cloudflared tunnel → localhost** to receive GitHub webhooks and OIDC callbacks locally.
- Reasons: (1) webhooks need a public URL (2) register OIDC/OAuth callbacks against a stable domain (avoid reconfiguring localhost) (3) clean prod/local separation.

## Consequences

- Need to replace the old workspace landing (mocco.club) and clean up redirects (separate task).
- The GitHub App (dev) webhook URL = `https://dev.mocco.work/api/webhooks/github`, callback also on dev.mocco.work.
- env: local uses dev.mocco.work, prod uses www.mocco.club. → [local-setup guide](../guides/local-setup.md)

## Reversal Conditions

- If we decide to revive the old workspace product, redistribute the domains (governance moves to app.mocco.work, etc.).
