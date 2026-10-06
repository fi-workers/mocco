---
title: Feature map — MVP scope
description: Sorts deploy-governance features into MVP versus Post-MVP against the "GitHub write ≠ deploy" wedge.
type: reference
status: active
created: 2026-07-04
updated: 2026-10-06
confidence: medium
owner: andrea
tags: [reference, mvp, scope, feature-map, prototype]
related:
  - ../adr/0002-mocco-is-an-independent-authorization-layer.md
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../adr/0005-tech-stack-vercel-native-next-fullstack.md
  - ./roadmap.md
---

# Feature map — MVP scope

> Scope of the **deploy governance** product line only. Mocco's other product lines and their order are in the [roadmap](./roadmap.md).
>
> Based on the prototype click-through + ADR 0002–0005. Organizes "what to ship first (MVP) and what to defer (Post-MVP)" against the wedge.

## Wedge (the cutting criterion)

**GitHub write ≠ deploy.** The gate is **actually enforced** — because cloud credentials (OIDC/STS) are not issued until an authorized role resumes. GitHub Actions is merely the first adapter (executor-agnostic).

**MVP = only what's needed to make this one sentence hold end-to-end.** Making it prettier, faster, and broader comes later.

## Status labels

| Label | Meaning |
|---|---|
| **Live** | Actual code exists (Next app) |
| **Prototype** | A click-through mock screen exists |
| **Not drawn** | No screen yet |
| ★ | enforcement core — the wedge depends on it |

## MVP — what makes the wedge hold

Goal: connect repo → define gate → prove that **without approval, a production deploy can't obtain credentials and is blocked** + record it in the audit log.

### Governance — deploy loop

| Feature | Status | Description |
|---|---|---|
| Deploy Queue | Live | main commit = deploy candidate → run. The workspace Overview lists each repo's commits; a commit's page triggers a run |
| Run detail | Live | One run: which commit, pipeline status, gates, the live step timeline and the resume action |
| Gate resume (approve) ★ | Live | Role-based resume, AND rule, `prevent_self`, reason required. approve ≡ resume |
| **Credential gating (OIDC broker)** ★ | **Live** (stub provider) | The broker releases a credential only to a resumed, verified run, fail-closed, against a grant allowlist (`.mocco.yml` `credential`). The only provider is a stub; a real cloud STS provider is still to come |
| Access (role → member) ★ | Live | Who can deploy/approve, separate from GitHub permissions. The `write ≠ deploy` surface |
| Pipeline & gate definition | Live | `.mocco.yml` = step + gate. Linear is enough for v1 (parallel DAG comes later) |
| Audit log | Live | Append-only hash chain. Approval/dispatch/credential events = compliance |

### Platform & Workspace — foundation

| Feature | Status | Description |
|---|---|---|
| Login (email+password) | Live | Vendor-neutral auth surface; Google SSO and GitHub account-linking land as separate PRs |
| Connect repo | Live | Install GitHub App → select repo → detect `.mocco.yml`. Onboarding |
| Commit sync | **Live** | Verify-first GitHub webhook (`push`/`installation`/`installation_repositories`) → tenant-isolated `mocco_commits` sync, deferred via `waitUntil`. Feeds the candidate-queue read path |
| Commit detail / config parse | **Live** | Per-commit `.mocco.yml` fetched at its SHA in the same deferred pass, parsed by the slice-1 `MoccoConfigParser`, and snapshotted 1:1 into `mocco_commit_configs` (best-effort per commit). The frontend commit-detail page renders the parsed steps from a pure DB read (`integration.commitDetail`). Observation slice (connect → commit queue → commit detail) is now complete; execution/gates are the next epic |
| **GitHub App + Cloud OIDC** ★ | **Live** (App) | Dispatch, webhooks and check runs through the GitHub App are live; cloud STS trust waits on a real credential provider |
| Workspace model (backend) | **Live** | `mocco_workspaces`/`mocco_members`, DB-enforced invariants — see [workspace model](./workspace.md) |
| Workspace UI | Live | Workspace switcher, Home, members list (read-only), settings (rename, delete) |
| Invite flow | Not drawn | Needs email delivery (#118) |

**MVP line**: connect a repo, define a gate, and a production deploy is **provably blocked** until an authorized role resumes (the credential broker proves it, recorded in the audit log). Both enforcement items (`credential gating`, `GitHub App + OIDC`) are now live against a stub credential provider; **the wedge holds end-to-end once a real cloud STS provider replaces the stub.**

## Post-MVP — after the wedge holds

Many are already drawn in the prototype (designed, but deferrable).

### Product line 1 — OTA release management (#99)

The first product after deploy governance, in phases set by the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md).

| Feature | Status | Description |
|---|---|---|
| Version policy and native force update | **Live** | Minimum, recommended and blocked versions per store app; tighten changes gated, relax changes reviewed after. See [OTA version policy](./ota-version-policy.md) |
| Gate existing OTA tools | **Live** | Mocco holds the EAS / CodePush / hot-updater publishing token and releases it only to a step behind a resumed gate. See [OTA external credentials](./ota-external-credentials.md) |
| Hosted Expo Updates | **Live** | Mocco serves updates to the stock `expo-updates` client (ADR 0021); the key stays in CI (ADR 0022); promotions to protected channels need approval (ADR 0020). See [Mocco-hosted OTA](./ota-hosting.md) |

### Product line 2 — Feature flags (#101)

Flags v1, per the [feature flags design](../specs/2026-09-24-feature-flags-design.md), [ADR 0023](../adr/0023-flag-targets-are-evaluation-scopes.md) and [ADR 0024](../adr/0024-flags-openfeature-flagd-ruleset-ofrep.md).

| Feature | Status | Description |
|---|---|---|
| Flag targets ("Environments") | Live | Evaluation scopes, each with its own versioned ruleset ([reference](./flags.md)); `flags:read` keys bound to one environment read it from `GET /v1/flags/ruleset` (ETag, 304); protected by a change gate |
| Flags, variants and targeting | Live | Boolean, string, number and JSON flags; rules on context attributes, segments, percentage rollout (`mocco-v1` bucketing) |
| Governed changesets | Live | Changes to a protected target are approval requests with a diff (ADR 0020) |
| Kill switch | Live | One-way, ungated, audited; restore is gated |
| Server SDK (local evaluation) | Live | `@mocco/flags-core` and an OpenFeature Node provider over the ETag'd flagd-compatible ruleset |
| Client SDKs (OFREP) | Live | OFREP bulk and single evaluation (client-visible flags only), the SSE change stream, `@mocco/openfeature-web` and `@mocco/openfeature-react-native` (offline copy, foreground refresh); React through `@openfeature/react-sdk` |
| Telemetry and stale flags | Live | SDKs send per-minute evaluation counts (`POST /v1/flags/telemetry`, hourly rollups); a daily job finds unused, never-evaluated and fully rolled-out flags; badges, dismiss-until and a weekly digest |
| Flags-as-code | Live | `.mocco/flags.yml` on the default branch produces changesets that still pass the gate. A default-branch push syncs it: unprotected environments apply, protected ones wait for the gate, and a refused file is recorded with its issues ([reference](./flags.md#flags-as-code-moccoflagsyml)). In the console, repo flags are marked, read-only except the kill switch, and the last syncs are listed ([guide](../customer/flags/flags-as-code.md)) |
| Pull request plan check | Live | A PR into the default branch that changes `.mocco/flags.yml` gets a **Mocco flags plan** check run: each project's changes per environment, which ones wait for approval, the flags created, taken over and handed back, or the issues that refuse the file. Never blocks a merge (`success` or `neutral`) ([reference](./flags.md#the-pull-request-plan-check)) |

### Product line 3 — Messenger (#95)

The first slice of the [messenger design](../specs/2026-09-24-messenger-design.md): in-app "contact us" for signed-in users ([reference](./messenger.md)).

| Feature | Status | Notes |
|---|---|---|
| Conversations and identity | Live | `/v1/messenger`: sessions for users the app's server signed (HMAC), conversations with categories, seq-numbered idempotent messages, read positions, per-contact limits |
| Team inbox | Live | The project's **Inbox** tab: setup (identity secret shown once), open/closed lists with unread, the thread with replies and internal notes, the user's current and starting app context, close/reopen, blocking, categories and secret rotation; Discord alerts through the Mocco preset ([customer guide](../customer/messenger/contact-us.md)) |
| React Native SDK | Live | `MessengerClient` in `@mocco/sdk-core` and headless hooks in `@mocco/react-native/messenger` (pure JS, Expo Go) |
| Attachments | Live | Up to 3 screenshots or PDFs (10 MB each) per message through object storage, verified on send (size, declared type and the bytes' signature), served with short-lived links, PDFs only as downloads; thumbnails and file chips in the inbox. The team attaches them to replies and notes from the inbox under the same checks |
| Guests | Live | Optional: people who aren't signed in write with an email, kept on the device by a guest token, merged into their account when they sign in there |
| Push replies | Live | Devices register Expo push tokens; a team reply is pushed unless already read; gone devices are disabled |

### Help center (#96)

The first slice of the [help center design](../specs/2026-09-24-help-center-design.md) ([reference](./help-center.md)).

| Capability | State | Notes |
|---|---|---|
| Sites, articles and revisions | Live | A project's help site (slug, source and target languages), collections → sections → articles, revisions with save (one per editing session), publish, unpublish and restore, public read with source-language fallback |
| Public site | Live | `<slug>.<HELP_SITES_DOMAIN>`: a home per language and article pages, ISR every 60 seconds (ADR 0015, draft) |
| Translation | Live | On publish, each offered language is machine-translated through `AI_GATEWAY_API_KEY` (structure-checked), served per language; reviewed text is never overwritten and shows as stale; the article editor's Translations section reviews each language; collection and section titles are translated with their articles |
| Custom domains | Live | `HELP_CUSTOM_DOMAINS` (`help.example.com=<slug>`) serves a site on the customer's domain; adding the domain is a deployment step for now |
| Console editor | Live | The project's **Help center** tab: setup, the tree, and a Markdown editor with live preview, autosave, pasted, dropped or picked images (public objects in storage, PNG/JPEG/WebP/GIF up to 10 MB), publish and history ([customer guide](../customer/help/help-center.md)) |
| App API and SDK | Live | `GET /v1/help/site`, `/collections/{slug}`, `/articles/{id}` and `/search` with a `help:read` key (publishable allowed), language-negotiated with ETags; `HelpClient` in `@mocco/js` and `@mocco/react-native/messenger` ([public API](./public-api.md)) |
| Was this helpful? | Live | Yes/no and an optional comment under each published article, from the public site's widget and `POST /v1/help/articles/{id}/feedback` (`sendFeedback`); one answer per visitor, article and day under a keyed hash; the article editor shows the last 30 days |

### Status page (#103)

Status pages, components, incidents and scheduled maintenance are built as a backend model and API
([status page model](./status.md)) and managed in the console ([customer guide](../customer/status/status-page.md)); each page is published as static files a plain web server can serve, and monitors run from private locations through the `@mocco/probe` agent; monitors and locations are managed in the console ([monitor guide](../customer/status/monitor-your-service.md)). The design is the [status page spec](../specs/2026-09-24-status-page-design.md), with
[ADR 0027](../adr/0027-status-probes-are-pull-based-agents.md) (probes) and
[ADR 0028](../adr/0028-status-pages-are-static-snapshots.md) (public pages). What sets it apart from a standalone
status tool is that every incident lists the runs that reached production just before it.

| Feature | Status | Description |
|---|---|---|
| Components, incidents and maintenance | Prototype | The project's Status page section manages pages, component groups and components (add, rename, reorder, delete, set the reported status, see the shown status), incidents (open/resolved lists, declare, post updates offering only legal transitions, affected components, postmortem) and maintenance windows (schedule, cancel, in progress/scheduled/past) ([customer guide](../customer/status/status-page.md)). A project's status pages with component groups and components; incidents (investigating → identified → monitoring → resolved) with a timeline, affected components with impact, and a postmortem; scheduled maintenance started and completed by a per-minute tick; each component's shown status derived from its manual status, open incidents and maintenance. Incident, maintenance and manual status changes are audited. Linking components to repos comes with deploy correlation. Maintenance from gated runs: the Maintenance tab names the gates that announce maintenance; resuming one starts a window on the page that the run's end completes, with a note when the run failed, was canceled or was rejected, flagged and alerted (`status.maintenance.overran`) once it runs past its expected minutes ([maintenance from gated runs](./status.md#maintenance-from-gated-runs)). Each run's window links to its run and shows its overrun and end note, also in `/v1`, the SDK and MCP |
| Public status page | Live | Every change marks the page dirty and the `status.snapshot.publish` job (plus a five-minute safety run) uploads a new version through object storage: an immutable `snapshot.json`, a pre-rendered `index.html` that works without JavaScript, an Atom feed, and the short-lived `current.json` pointer written last (ADR 0028). Only published incidents appear; the last 20 versions are kept. Self-hosters serve the filesystem driver's `pub/status` directory with any static server, and it keeps serving when the app is down ([status page model](./status.md#public-page)). Each component shows 90 daily bars from its component days (worst status and uptime per day, readable without JavaScript), and a changed bar republishes the page. Not yet: the `<slug>.status.mocco.club` CDN mapping, custom domains, and a publish status in the console |
| HTTP and TCP monitors | Prototype | Status code, keyword, latency threshold and TLS expiry; 60-second minimum interval; run by `@mocco/probe` agents that lease their work (ADR 0027). Built so far: the monitor and location model with its `status.*` procedures, private location tokens, the server side of the probe protocol (leasing, result ingest into day-partitioned storage, heartbeats), the verdict evaluator, and the `@mocco/probe` agent with its container image and the hosted address block list ([status page model](./status.md#the-probe-agent)), and the embedded probe for a single-node self-host (`STATUS_PROBE_EMBEDDED`); checked end to end from a private location. A monitor's state drives its components' shown status, opens a draft (or, per monitor, published) incident on down that follows the recovery, and sends `status.monitor.down` / `.degraded` / `.recovered` alerts through notification rules ([what a state change does](./status.md#what-a-state-change-does)). The console's Monitors view creates, edits, pauses, resumes and deletes monitors and shows each one's rounds, state changes, open incident and deploy watch; its Locations view creates private locations with the token shown once, rotates and disables them ([monitor guide](../customer/status/monitor-your-service.md)). Not yet: hosted locations, and publishing the package and image |
| Multi-region consensus | Not drawn | A monitor is down only when a quorum of locations fails for consecutive rounds; a silent location is `no_data`, never downtime. Hosted regions plus private locations behind NAT. Built so far: the quorum and the up/suspect/down/recovering state machine in the evaluator, with an immediate recheck on suspect ([status page model](./status.md#verdicts-and-the-state-machine)) |
| Uptime history and 90-day bars | Live | Each monitor's uptime per UTC day from its state changes (time down, not failed rounds), minus maintenance, with latency percentiles, and each component's day for the public page's 90-day bars. Built so far: the `status.rollup` job every ten minutes writing hourly rollups (kept 90 days), daily rollups and component days (kept forever) with fixed log-bucket latency histograms, and `STATUS_RAW_RETENTION_DAYS` for raw results ([uptime rollups](./status.md#uptime-rollups)); the public page's 90-day bars ([public page](./status.md#public-page)), republished when a bar changes; and each monitor's uptime and p50/p95 latency for the last 48 hours and 90 days on the `status.monitor` read and `mocco_status_monitors_get` (detailed). Not yet: a latency chart in the console |
| Heartbeat monitors | Live | Cron jobs ping `/v1/ping/:token` (`/start`, `/fail`, `/:exitCode`; GET or POST, no key); silence past period plus grace is down. Built so far: the heartbeat kind with its hashed `mhb_` token (shown once, rotatable), period and grace; the ping routes with a 404 identical to a missing route and per-token and per-address limits; silence detection in the evaluator and one-confirmation transitions through the same state changes, incidents, alerts and rollups as probe monitors; a paused heartbeat records pings without changing state ([heartbeat monitors](./status.md#heartbeat-monitors)); the console's Heartbeat kind with the ping URL shown once and copyable `curl` snippets, the last ping and run time and **Replace ping URL** on the monitor page, and `heartbeat(token).wrap(fn)` in `@mocco/node` ([monitor guide](../customer/status/monitor-your-service.md#6-heartbeats-for-cron-jobs-and-workers)). Not yet: the `hb.mocco.club` host |
| Monitors and incidents as code | Prototype | A secret key with `status:write` manages the project's status from CI or a script; `status:read` reads it. Built so far: the `/v1` routes for monitors upserted idempotently by a caller-chosen `key` (`PUT /v1/monitors/by-key/{key}` answers `unchanged` and writes nothing when the monitor already matches), pause, resume and delete; incidents and their updates and components; maintenance windows; pages and component statuses; and the locations to run at ([the /v1 management API](./status.md#the-v1-management-api)). Answers are explicit DTOs without a URL's secrets or any token hash, changes are audited as the key acting for its creator, and an OpenAPI 3.1 description is served at `/v1/status/openapi.json`. `@mocco/node`'s `createMoccoServer({ secretKey }).status` wraps every route (`status.monitors.upsert(key, input)` and the rest, plus `locations.idsOf(codes)`) |
| Deploy correlation and deploy watch | Not drawn | An incident shows the runs that finished before it started, linked both ways; after a run succeeds its monitors check every 30 seconds for 15 minutes, and a failure opens an incident naming the run. Built so far: `mocco_status_incident_runs` and `CorrelationService` ([deploy correlation](./status.md#deploy-correlation)) suggest the recorded releases from two hours before an incident to five minutes after, scored by distance and scoped to the project's linked repos (the workspace when none), with audited manual links and the `status.*` procedures for both sides; the incident page's Recent deploys panel (link, unlink, recompute) and the run page's Incidents panel. The [deploy watch](./status.md#the-deploy-watch): `deploy.released` sets a 15-minute, 30-second watch on the released projects' monitors, a `down` during it opens a `deploy_watch` incident with `suspected_run_id` (2x in the score) and appends `status.post_deploy_check_failed` to the run's timeline, never changing the run; `POST /v1/monitors/{id}/check` (a `status:write` secret key) runs a round now from a pipeline step |
| Subscribers | Live | Email with double opt-in, RSS/Atom, signed webhooks ([guide](../customer/status/subscribers.md)). Built: email sign-ups on `POST /v1/status-pages/{slug}/subscribers` (rate-limited, a honeypot, the same answer whoever signs up, component filters), the confirmation mail, signed single-purpose confirm and unsubscribe links (one-click `List-Unsubscribe`), and the fan-out of published incident updates and maintenance changes with one delivery per subscriber and notice, in English and Korean, through the email sender (`EMAIL_DRIVER` `smtp` or `log`) ([subscribers](./status.md#subscribers)); the Atom feed is in every snapshot; Standard Webhooks-signed webhook subscribers whose host is checked against the shared address policy at sign-up and at connect time, with no redirects followed; and the **Get updates** form on the public page, which works without JavaScript and only changes its own message when the sign-up fails. Not yet: the console's subscriber list |
| `/v1` management API, SDK and MCP tools | Not drawn | Monitors, incidents and maintenance from CI, `@mocco/sdk` and agents (ADR 0025) |

**Not in v1:** on-call schedules and escalation, phone and SMS; browser, multi-step, DNS and ICMP checks; intervals
under 30 seconds; automatic rollback on a failed post-deploy check (that needs its own ADR); private or SSO-gated
pages; latency charts on the public page; a dedicated time-series database.

### Deploy loop depth

| Feature | Status | Description |
|---|---|---|
| Parallel fan-in DAG / matrix | Prototype | Branching, parallel `lint·unit·e2e`, conditional stages. v1 stays linear |
| Concurrency modes | Prototype | oldest/newest/newest-ready wait queue. MVP defaults to `oldest_first`, no UI |
| Verify Action UI | Prototype | 17-item early-fail checklist. Enforcement is the credential gate — this is secondary |
| Rollback / re-deploy | Prototype | Rollback to last-good SHA (outdated-exempt, separate approval). Button only |
| Break-glass | Prototype | Emergency path when a resumer is absent — red audit + after-the-fact review. After trust is built |

### Reach & operations

| Feature | Status | Description |
|---|---|---|
| Slack notifications | Prototype | Approval-request/deploy/override events → channel. Discord delivery is live ([notifications](./notifications.md)); Slack is #117 |
| Org policy override | Prototype | WS rules a repo can't weaken (monotonic hardening). An enterprise concern |
| Multi-cloud (GCP WIF) | Not drawn | A second broker beyond AWS STS. One is enough to prove the model |
| Ops — Monitors/Incidents | Not drawn | Post-deploy health/incident integration. Now its own product line — see [Status page (#103)](#status-page-103) above |
| Billing / Plan | Not drawn | Usage/plans. Needed for billing, unnecessary to prove value |
