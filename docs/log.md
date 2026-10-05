---
title: Wiki log
description: Append-only chronological record of what changed in docs/ and why, one entry per PR that changes docs.
type: journal
status: active
created: 2026-09-24
updated: 2026-10-05
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

## 2026-10-02 — Getting-started and deploy-governance customer guides

- Added the `start` guide set (what Mocco offers, workspace and projects, members and access, API keys, the audit
  log) and the `governance` set (deploy governance overview), with screenshots from a local run; listed the
  existing messenger guide, which had no set, so `/docs/messenger/contact-us` now renders.
- The governance guide has no commit or run screenshots: the local workspace had no synced commits or runs, and
  making them would have meant changing data. The audit screenshot is cropped to the table.
- Docs touched: `customer/start/*`, `customer/governance/*`, `log.md`
- Source: branch `docs/getting-started`

## 2026-10-05 — Agents can resume paused runs

- The connect guide lists `mocco_gates_resume`, says what its confirmation shows (a reject halts the run), that one
  permission covers voting and resuming, and adds the resume refusals to troubleshooting. The MCP spec marks slice 6c
  shipped, records how the resume is built, and decides its open question: the tool stays behind `approvals:write`,
  because roles already separate who may vote from who may resume, and a separate scope can be split later through
  the same step-up without breaking clients. The workspace reference notes the resume tool reads the switch too.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/workspace.md`,
  `log.md`
- Source: branch `feat/mcp-gates-resume`

## 2026-10-04 — MCP sign-in, end to end

- The connect guide gains "Approving the connection" with a screenshot of the new consent screen, the correct
  discovery paths (`/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-authorization-server/api/auth`),
  and a troubleshooting row for a sign-in that loses the client's request. The MCP spec records what slice 4 left out
  and how it was found.
- Docs touched: `customer/mcp/connect.md`, `customer/mcp/images/mcp-consent.png`,
  `specs/2026-10-02-mcp-and-cli-design.md`
- Source: branch `fix/mcp-sign-in-flow`

## 2026-10-04 — Positioning around the production record

- Added [ADR 0026](./adr/0026-position-mocco-around-the-production-record.md): Mocco is one workspace to release,
  control and support an app; "write ≠ ship" generalizes "write ≠ deploy"; products and console sections are
  grouped by job (Release, Support, Operate), from the frontend product registry.
- Rewrote the product description in the root `README.md`, `AGENTS.md` and `index.md` to list what has shipped,
  and added a "where it stands" section to the roadmap, since the shipping order diverged from the waves.
- Docs touched: `adr/0026-*`, `adr/README.md`, `index.md`, `reference/roadmap.md`, `log.md`
- Source: PR #349

## 2026-10-05 — Every event family reaches the notification fan-out

- The fan-out subscribed to a hand-kept list of families that missed `flags.*` and `messenger.*`, so `mocco` preset
  rules for flag changesets, kill switches, the stale digest and messenger conversations never fired. The
  notifications reference now says the subscriptions cover every catalog family, enforced by the type of
  `NotificationSubscribers`; the events reference lists the families and tells a new catalog family to add its entry.
- Docs touched: `reference/notifications.md`, `reference/events.md`, `log.md`
- Source: branch `fix/notification-fanout-coverage`

## 2026-10-05 — Deploy correlation in the console

- The status guide gains "Check the deploys around it" with a screenshot of the Recent deploys panel (the
  postmortem and maintenance steps become 7 and 8, and run links join what gets recorded); the status reference
  describes the incident page's Recent deploys panel and the run page's Incidents panel; the feature map row drops
  "no console panels".
- Docs touched: `customer/status/status-page.md`, `customer/status/images/recent-deploys.png`,
  `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-correlation-ui` (#154)

## 2026-10-05 — Help center /v1 reads and the SDK

- The public API reference lists `GET /v1/help/site`, `/collections/{slug}` and `/articles/{id}` with their
  language negotiation and ETags, and says the table plus `@mocco/common/help-v1` is the contract (no OpenAPI
  description). The help center reference gains "The /v1 read API", including the messenger's in-process search
  contract; the SDK reference adds `HelpClient`'s reads and `createHelp` in `@mocco/js`; the feature map gains an
  "App API and SDK" row.
- The customer guide gains "Show articles in your app".
- Docs touched: `reference/public-api.md`, `reference/help-center.md`, `reference/sdk.md`,
  `reference/feature-map.md`, `customer/help/help-center.md`, `log.md`
- Source: branch `feat/help-v1-read` (#216)

## 2026-10-05 — Help center: Was this helpful?

- The help center reference gains "Was this helpful?": `mocco_help_feedback` (migration 0065), the two surfaces (`/v1` and
  the public site's `/api/help/feedback`), one answer per visitor, article and day, the keyed visitor hash with its
  network fallback, the per-address limit, no audit, and the editor's 30-day section; `helpfulness` joins the operator
  API. The public API lists `POST /v1/help/articles/{id}/feedback`, the SDK reference `sendFeedback`, and the feature
  map gains a row.
- The customer guide shows the widget under articles and the editor's section, with two screenshots, and how to send
  feedback from an app.
- Docs touched: `reference/help-center.md`, `reference/public-api.md`, `reference/sdk.md`, `reference/feature-map.md`,
  `customer/help/help-center.md`, `customer/help/images/helpful-widget.png`, `customer/help/images/helpfulness.png`,
  `log.md`
- Source: branch `feat/help-feedback` (#216)

## 2026-10-05 — Help center editor: images and autosave

- The help center reference gains "Images": `HelpImageService` (moved out of the import service), uploads completed
  only for the project's own help center objects, the byte-signature check, and Markdown referring to the public
  URL with `mocco_objects` as the ownership record (no per-article image table). Revisions now say how saves within
  an editing session (same author, unpublished `source_edit`, under 10 minutes) rewrite the draft instead of adding
  one, and the console section describes autosave. The storage reference notes `completeUpload`'s owner check.
- The customer guide replaces Save draft with autosave, adds "Add images" with a screenshot, and retakes the editor
  screenshot; the feature map's help center rows follow.
- Docs touched: `reference/help-center.md`, `reference/storage.md`, `reference/feature-map.md`,
  `customer/help/help-center.md`, `customer/help/images/editor.png`, `customer/help/images/editor-images.png`, `log.md`
- Source: branch `feat/help-editor-images` (#208)

## 2026-10-05 — Status deploy correlation

- The status reference gains "Deploy correlation": `mocco_status_incident_runs`, what counts as a deploy (a recorded
  release, not any succeeded run, since the registry is the production marker the design's open question asked
  for), the scope (the incident's project's linked repos, else the workspace), the `[-2h, +5m]` window and score,
  suggestions on open and on demand, audited manual links, and the `incidentRuns`, `correlateIncident`, `linkRun`,
  `unlinkRun` and `runIncidents` procedures. The feature map and the release registry reference point to it.
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `reference/releases.md`, `log.md`
- Source: branch `feat/status-incident-correlation` (#154)

## 2026-10-05 — Release registry and `deploy.released`

- Added the release registry reference: a release is a run that succeeded and passed at least one resumed gate
  (ADR 0003), recorded once per project linked to the run's repo in `mocco_releases`, announced once as
  `deploy.released`, and filled in by the hourly `releases.reconcile` job when the event path loses one. The events
  reference lists the type, its payload and the `release.record` subscriber; the project reference drops the
  "lands later" note; the index links the new page. The notifications reference adds `deploy.*` to the fan-out and
  the `deploy.released` message.
- Docs touched: `reference/releases.md`, `reference/events.md`, `reference/project.md`, `reference/notifications.md`,
  `index.md`, `log.md`
- Source: branch `feat/release-registry` (#112)

## 2026-10-05 — Monitor state drives components, incidents and alerts

- The status reference gains "What a state change does": the evaluator's `onStateChange` port, the pages marked dirty
  when a monitor's change shows on a component, the monitor-origin incident (`incident_policy`, draft by default,
  held as a draft during maintenance, followed to monitoring and resolved, one open per monitor through
  `mocco_status_incident_monitors`), audit with no actor, and the `status.monitor.*` alerts deduped per state change.
  "What a component shows" adds the monitors. The events reference lists the three status types and their payload;
  the notifications reference adds `ota.*` and `status.*` to the fan-out and the status types to the `mocco` preset.
  The feature map's monitors row says what is built.
- Docs touched: `reference/status.md`, `reference/events.md`, `reference/notifications.md`,
  `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-monitor-incidents` (#150, part 6)

## 2026-10-05 — Status embedded probe

- The status reference gains "The embedded probe": `STATUS_PROBE_EMBEDDED` runs `@mocco/probe`'s loop inside a
  single-node self-hosted server as the shared `embedded` location, calling `ProbeService` directly; how the location
  is created, that it starts once per process with the first job tick, that it never runs on Vercel, what a second
  process does, and how it stops. "Not built yet" drops the embedded probe. The env reference gains the status probe
  variables. The SDK packages page notes the probe's `create-agent` entry, and the feature map's monitors row lists
  the embedded probe as built.
- Docs touched: `reference/status.md`, `reference/env.md`, `reference/sdk.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-probe-embedded` (#150, part 5)

## 2026-10-05 — Status probe agent

- The status reference gains "The probe agent": the `@mocco/probe` loop (lease, run at the round time with jitter,
  report in batches, heartbeat, backoff, a clean stop), its environment, what each HTTP and TCP check measures and
  how it fails, the hosted address block list checked on every connection and redirect hop, and a runbook for a
  private location while the console can't create one. The probe protocol notes that `timings` may carry any subset
  of phases and that the answers have schemas the agent parses with. "Not built yet" now lists the embedded probe,
  hosted locations and publishing. The SDK packages page lists `@mocco/probe`; the feature map's HTTP and TCP monitors
  row becomes Prototype, checked end to end from a private location.
- Docs touched: `reference/status.md`, `reference/sdk.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-probe-agent` (#150, part 4)

## 2026-10-05 — Status verdict evaluator

- The status reference gains "Verdicts and the state machine": when a round closes, how the quorum and the verdict
  are decided, the state transition table, the immediate recheck, and the per-monitor lock. The partition section
  becomes "Time series and their partitions", covering round verdicts (30 days) beside raw results, and the
  `status.retention` job's new name `TimeSeriesRetention`. The results paragraph adds the refusal of a result before its
  round and the inline evaluation. Tables list `mocco_status_round_verdicts` and the monitor streaks. The feature map's
  monitors and consensus rows say what is built.
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-verdict-evaluator` (#150, part 3)

## 2026-10-05 — Status probe protocol

- The status reference gains "Probe protocol" (the `/v1/probe` lease, results and heartbeat routes, location-token
  auth, `SKIP LOCKED` leasing and which results are accepted, refused or duplicates) and "Raw results and their
  partitions" (day partitions of `mocco_status_check_results`, the custom migration that creates the parent, and the
  hourly `status.retention` job). Its tables list the leases and results, and "Not built yet" now names the evaluator
  and the agent. The feature map's HTTP and TCP monitors row adds the protocol to what is built.
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-probe-protocol` (#150, part 2)

## 2026-10-05 — Status monitors and probe locations

- The status reference gains "Monitors and the probe protocol": the monitor spec by kind, private and shared probe
  locations with tokens shown once and stored as SHA-256 hashes, and how pause and resume share the monitor's
  advisory lock with the evaluator and record state changes. Its tables, audit and tRPC sections list the new tables,
  actions and procedures, and "Not built yet" names what checking a monitor still needs. The feature map's HTTP and
  TCP monitors row says what is built so far.
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-monitors-model` (#150, part 1)

## 2026-10-05 — Status pages publish as static snapshots

- The status reference gains "Public page": how a change marks the page dirty and the `status.snapshot.publish`
  job builds, stores and uploads a version, what the snapshot may contain (published incidents only), the files
  and their cache headers, and a self-host runbook (serve `pub/status` with any static server; what visitors see
  while the app is down). The tables list `mocco_status_page_snapshots`, the page's publish columns and incident
  `visibility`, and the stale "MCP tools come in the next slice" line now points at the MCP section. The storage
  reference notes the `pub/status/` prefix and atomic filesystem writes; the feature map marks the public page Live.
- Docs touched: `reference/status.md`, `reference/storage.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-static-snapshot` (#149)

## 2026-10-05 — Agents can change webhook sources

- The connect guide lists `mocco_inbound_sources_create`, `_pause`, `_resume` and `_delete` with the deciding tools
  and says a signing secret never passes through the agent: GitHub sources are created without returning their
  secret (rotate it in the console to get one), Sentry and Vercel sources are refused with a pointer to the console.
  The MCP spec gains "How the webhook source changes are built" and marks issue #246's MCP surface complete. The
  inbound reference gains the audit actions and an MCP section; the workspace reference says the opt-in covers
  webhook sources too.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/inbound.md`,
  `reference/workspace.md`, `log.md`
- Source: branch `feat/mcp-inbound-sources-write`

## 2026-10-05 — Agents can change where notifications go

- The connect guide lists `mocco_notifications_channels_connect`, `_channels_reenable`, `_rules_add`, `_rules_remove`
  and `_presets_apply` with the deciding tools, and `mocco_notifications_discord_channels_search` with the reads; it
  says what each confirmation shows, that only owners and admins may change notification settings, and what stays
  in the console. The MCP spec gains "How the notification changes are built" (issue #246 part 2). The notifications
  reference lists the new audit actions and the MCP tools; the workspace reference says the opt-in now covers
  notification changes too.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/notifications.md`,
  `reference/workspace.md`, `log.md`
- Source: branch `feat/mcp-notifications-write`

## 2026-10-05 — Agents can read notifications

- The connect guide lists `mocco_notifications_channels_search`, `mocco_notifications_rules_search`,
  `mocco_notifications_activity_search` and `mocco_inbound_sources_search`, and says they read the whole workspace,
  never return a secret, and that the source tool explains a server without `SECRETS_ENCRYPTION_KEYS`. The MCP spec
  lists them as shipped (issue #246 part 1) with what is left: creating sources, connecting channels and editing
  rules, behind the opt-in and the confirmation. The notifications reference gains an MCP section.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/notifications.md`,
  `log.md`
- Source: branch `feat/mcp-notifications-read`

## 2026-10-05 — Agents can read the status page

- The connect guide lists `mocco_status_pages_get`, `mocco_status_incidents_search`, `mocco_status_incidents_get` and
  `mocco_status_maintenances_search`, and says how a status tool picks its project and page. The MCP spec lists the
  status reads as shipped and what is left (a tool that declares or updates an incident); the status reference notes
  the tools and the checks in front of them.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/status.md`, `log.md`
- Source: branch `feat/mcp-status-read`

## 2026-10-05 — Agents can read OTA

- The connect guide lists `mocco_ota_channels_search`, `mocco_ota_releases_search`, `mocco_ota_adoption_get` and
  `mocco_ota_version_policies_search`, and says how an OTA tool picks its project and hosted app. The MCP spec marks
  the OTA reads of slice 8 shipped and lists what is left; the OTA hosting and version policy references note the
  tools and the checks in front of them.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/ota-hosting.md`,
  `reference/ota-version-policy.md`, `log.md`
- Source: branch `feat/mcp-ota-read`

## 2026-10-05 — Agents can read feature flags

- The connect guide lists `mocco_flags_search`, `mocco_flags_get` and `mocco_flags_changesets_search`, and says how a
  flag tool picks its project and that it answers only where flags are turned on. The MCP spec marks the flag reads of
  slice 8 shipped and lists what is left (OTA reads, a stale filter, mutating flag tools); the flags reference notes
  the tools and the checks in front of them.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/flags.md`, `log.md`
- Source: branch `feat/mcp-flags-read`

## 2026-10-04 — Workspace switch for agents that decide

- Added the "Agents on the MCP surface" section to the workspace reference: `mocco_mcp_settings`, the
  `agents_may_decide` opt-in (off by default, owners and admins change it, audited), and its place in the console.
  The MCP spec records that slice 6 ships as three PRs, and the connect guide says the switch has landed before the
  tools it unlocks.
- Docs touched: `reference/workspace.md`, `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`
- Source: branch `feat/mcp-agents-setting`

## 2026-10-05 — Agents can vote on approvals

- The connect guide lists `mocco_approvals_vote`, says what the confirmation shows and that declining votes nothing,
  adds "Allowing an app to vote" for the step-up consent, and replaces the stale "tools are missing" troubleshooting
  row with the refusals a person can now meet. The MCP spec marks slice 6b shipped and records how the scope,
  step-up, confirmation state and errors are built; the workspace reference notes the vote tool reads the switch.
- Docs touched: `customer/mcp/connect.md`, `specs/2026-10-02-mcp-and-cli-design.md`, `reference/workspace.md`,
  `log.md`
- Source: branch `feat/mcp-approvals-vote`

## 2026-10-04 — Mocco is everything a product needs, except the code

- Added [ADR 0029](./adr/0029-mocco-is-everything-a-product-needs-except-the-code.md), superseding ADR 0026's
  position: release, operations and support are equal parts of building and running a service, and the shared
  team, roles and history set Mocco apart; "write ≠ ship" is the Release principle. ADR 0026's grouping and
  navigation decisions carry over.
- Rewrote the product description in the root `README.md`, `AGENTS.md` and `index.md` accordingly.
- Docs touched: `adr/0026-*` (status), `adr/0029-*`, `adr/README.md`, `index.md`, `reference/roadmap.md`, `log.md`
- Source: PR #357

## 2026-10-05 — Status page console: incidents and maintenance

- The status page section gains Components, Incidents and Maintenance views (`?tab=`): open and resolved incident
  lists (`?filter=`), declaring an incident with severity and affected components, an incident page with updates
  that offer only legal transitions (a refused one shows the domain error), the timeline, affected components and
  the postmortem; and maintenance windows grouped by state, scheduled and canceled from the console. This finishes
  the console part of #148.
- Added the customer guide [Run a status page](./customer/status/status-page.md) with screenshots cropped to page
  content, registered as the `status` guide set, and listed it in the getting-started overview (the status page is
  no longer "on the roadmap").
- Docs touched: `customer/status/status-page.md`, `customer/start/overview.md`,
  `customer/start/workspace-and-projects.md`, `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-console-incidents` (issue #148)

## 2026-10-05 — Status page console: pages and components

- The project's Status page section (#148, part 3) creates a status page, switches between pages (`?page=`),
  renames it, changes its address and deletes it, and manages its component groups and components: add, rename,
  regroup, move up and down, delete, and set the reported status next to the status the page shows. The status
  product is now listed as available on the Products page. The [status page model](./reference/status.md) gains a
  Console section; the feature map's Status row says what has a screen.
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `log.md`
- Source: branch `feat/status-console-pages` (issue #148)

## 2026-10-04 — Status page architecture decisions

- Added ADR 0027 (status probes are pull-based agents: one `@mocco/probe` for hosted regions and private locations,
  Vercel functions and Cloudflare cron rejected as probers, hosting kept out of code) and ADR 0028 (public status
  pages are static snapshots on object storage behind a CDN, the deliberate exception to ADR 0015's ISR). The status
  spec links both, publishes through the storage domain's `ObjectStore` port instead of its own bucket settings, and
  records that Fly.io has no Seoul region. The feature map gains a Status page section with the v1 scope and
  non-goals.
- Docs touched: `adr/0027-status-probes-are-pull-based-agents.md`, `adr/0028-status-pages-are-static-snapshots.md`,
  `adr/README.md`, `index.md`, `specs/2026-09-24-status-page-design.md`, `reference/feature-map.md`
- Source: branch `docs/status-adrs` (issue #147)

## 2026-10-05 — Status pages and components

- Added the [status page model](./reference/status.md) reference for the first part of #148: status pages,
  component groups and components, their tenancy through composite foreign keys, the audit actions and the
  `status.*` router. The feature map's "Components, incidents and maintenance" row moves to Prototype (backend
  only, pages and components so far; incidents and maintenance are next).
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `index.md`, `log.md`
- Source: branch `feat/status-model` (issue #148)

## 2026-10-05 — Status incidents and maintenance

- Extended the [status page model](./reference/status.md) with the rest of #148: incidents with their timeline,
  affected components and postmortem, the transition rules and the `resolved_at` invariant, scheduled maintenance
  and the `status.maintenance.tick` job, how a component's shown status is derived, and the new audit actions and
  router procedures. The feature map's "Components, incidents and maintenance" row now describes all of it
  (still Prototype, backend only).
- Docs touched: `reference/status.md`, `reference/feature-map.md`, `index.md`, `log.md`
- Source: branch `feat/status-incidents-model` (issue #148)

## 2026-10-04 — Customer screenshots show page content only

- Cropped the 25 flags, messenger, help center, OTA hosting and deploy governance screenshots to the page content,
  removing the old sidebar, project tabs and dev overlays, and added a "Customer guide screenshots" rule to the
  [conventions](./meta/conventions.md): screenshots show content, not the app shell, except in the guides that
  teach the navigation. A navigation change no longer stales every guide.
- Docs touched: `customer/*/images/*`, `meta/conventions.md`, `log.md`
- Source: PR #359

## 2026-10-04 — Audit log: what verify proves, and what it costs

- Corrected the audit spec: a `seq` gap is normal (a rolled-back insert uses a value) and `verify` doesn't check
  for gaps; a middle deletion breaks the `prev_hash` link instead. Tail truncation is stated as a known limitation
  until KMS signing. The spec also records that `verify` walks the chain in pages and that the console no longer
  polls it, and that a credential request with a bad run token isn't audited.
- The audit customer guide says the check runs when the page opens and on Re-verify, explains numbering gaps,
  and names tail truncation.
- Docs touched: `superpowers/specs/2026-07-29-slice8-audit-log-design.md`, `customer/start/audit-log.md`, `log.md`
- Source: branch `fix/audit-verify-cost` (issue #92)
