---
title: Wiki log
description: Append-only chronological record of what changed in docs/ and why, one entry per PR that changes docs.
type: journal
status: active
created: 2026-09-24
updated: 2026-09-25
confidence: high
owner: andrea
tags: [meta, log, wiki]
related:
  - ./index.md
  - ./meta/conventions.md
---

# Wiki log

What changed in the docs, oldest first. Entry format and rules: [conventions](./meta/conventions.md#changelog-and-log).
Structural changes to the wiki itself also get their rationale in the [meta changelog](./meta/changelog.md).

## 2026-09-24 — Mocco as an all-in-one platform: roadmap, research, designs

- Repositioned Mocco as an all-in-one developer platform in `index.md` (and the root `README.md` / `AGENTS.md`);
  deploy governance is its first product line and `reference/feature-map.md` now scopes only that line.
- Added [the product roadmap](./reference/roadmap.md), competitor research for ten product lines plus all-in-one
  platforms under `research/` (new folder), and one implementation design per product plus the shared
  [platform foundations design](./specs/2026-09-24-platform-foundations-design.md) under `specs/`. Research is
  `confidence: medium`; claims marked "(unverified)" were not confirmed.
- Docs touched: `index.md`, `reference/feature-map.md`, `reference/roadmap.md`, `research/*`, `specs/2026-09-24-*`,
  `meta/changelog.md`
- Source: PR #107

## 2026-09-24 — Agent orchestration harness and docs lint

- Added `yarn docs:lint` and made every document pass it: frontmatter for the 7 superpowers specs/plans that had none,
  schema-valid `type` values, and missing `updated` / `confidence` / `tags`. Values filled in this entry are
  `confidence: medium` because they were not re-verified against the code.
- `index.md` now links every ADR, the missing reference pages, and the superpowers specs/plans; `adr/README.md` lists
  ADRs 0007–0012 in its table.
- Added the [agent orchestration guide](./guides/agent-orchestration.md) for `WORKFLOW.md` and `scripts/agents/`.
- Docs touched: `index.md`, `README.md`, `adr/README.md`, `meta/schema.md`, `meta/conventions.md`,
  `meta/changelog.md`, `guides/agent-orchestration.md`, `guides/pr-workflow.md`, `reference/env.md`, `superpowers/specs/*`,
  `superpowers/plans/*`
- Source: branch `chore/agent-harness`

## 2026-09-25 — Projects and product enablement (ADR 0013)

- Added ADR 0013 (draft): projects sit below workspaces and scope every product after deploy governance; products
  are enabled per workspace, governance always on. Added the project model reference and pointed the backend
  conventions at the shared project procedures and the unique-constraint error path.
- Docs touched: `adr/0013-mocco-is-a-multi-product-platform.md`, `adr/README.md`, `reference/project.md`,
  `reference/backend-conventions.md`, `index.md`
- Source: branch `feat/platform-projects` (issue #108)

## 2026-09-25 — OTA release control decisions

- Recorded the OTA scope decisions: five phases (gate existing OTA tools, version policy and native force update,
  Expo Updates hosting, a CodePush-compatible device layer, crash-driven auto pause) and one direction rule with
  post-hoc review. Added CodePush technical and market research. The existing OTA design is now scoped to phase 3.
- Docs touched: `specs/2026-09-25-ota-release-control-design.md`, `specs/2026-09-24-ota-design.md`,
  `research/codepush-technical.md`, `research/codepush-market.md`, `reference/roadmap.md`, `index.md`
- Source: branch `docs/ota-release-control`

## 2026-09-25 — Approvals outside runs

- Added the approvals reference: `pre_approval` and `review` requests, pinned requirements, the voter guards
  shared with run gates, and the audit actions. The OTA release control design now points at it instead of a
  `pending_review` state.
- Docs touched: `reference/approvals.md`, `specs/2026-09-25-ota-release-control-design.md`, `index.md`
- Source: branch `feat/approvals-outside-runs` (issue #114)

## 2026-09-25 — OTA version policy

- Added the OTA version policy reference (rules, change classification, gating, concurrency, history). Noted in the
  approvals reference that superseding never touches pending reviews. Corrected two details in the OTA release
  control design (where the recommended ≥ minimum rule is checked; `revision` type).
- Docs touched: `reference/ota-version-policy.md`, `reference/approvals.md`,
  `specs/2026-09-25-ota-release-control-design.md`, `index.md`
- Source: branch `feat/ota-version-policy`

## 2026-09-25 — OTA public version check

- Documented the public version-check endpoint (response, locale fallback, fail-open for unknown apps, default
  store links, caching and ETag). Moved per-version adoption telemetry out of the endpoint slice in the release
  control design: CDN caching makes server-side counts wrong, so it needs an uncached client report.
- Docs touched: `reference/ota-version-policy.md`, `specs/2026-09-25-ota-release-control-design.md`
- Source: branch `feat/ota-version-check`

## 2026-09-25 — OTA external credentials

- Added the OTA external credentials reference (phase 1: the existing OTA tool's publishing token, sealed and
  released by the broker only to a gated step) and the `ota-*` provider ids in the `.mocco.yml` spec.
- Docs touched: `reference/ota-external-credentials.md`, `reference/mocco-yml-spec.md`, `index.md`
- Source: branch `feat/ota-external-credentials`

## 2026-09-26 — Notifications screen and customer guides

- Added the customer guides for notifications (`customer/notifications/*`: overview, connecting Discord, Sentry,
  Vercel, GitHub, Mocco events, troubleshooting) with screenshots taken from a local run of the Notifications
  screen. The add-channel screenshot is omitted: that dialog needs a live Discord bot, so the steps stay text-only.
- Added "tRPC context composition" to the backend conventions: one `productionServices()` builds every context,
  and optional services are required `X | undefined` keys so a builder can't silently drop one.
- Docs touched: `customer/notifications/*`, `reference/backend-conventions.md`
- Source: branch `feat/notifications-ui-v2`

## 2026-09-26 — Multi-product app shell

- Frontend conventions: the nav now comes from the product registry (`lib/products.ts`), hidden per disabled
  product; the top bar gains a project switcher; project-scoped products live under
  `/workspaces/[id]/p/[projectId]/…`.
- Docs touched: `reference/frontend-conventions.md`
- Source: branch `feat/app-shell-projects` (issue #109)
