---
title: OTA release control — phased scope and design
description: The decided scope and order for Mocco's React Native release product — gating existing OTA tools, version policy and native force update, Expo Updates hosting, a CodePush-compatible device layer, and crash-driven auto pause — with one set of direction-aware approval rules across all of them.
type: spec
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [spec, design, ota, release, force-update, codepush]
phase: design
implements: ../adr/0013-mocco-is-a-multi-product-platform.md
related:
  - ./2026-09-24-ota-design.md
  - ./2026-09-24-platform-foundations-design.md
  - ../research/ota-competitors.md
  - ../research/codepush-technical.md
  - ../research/codepush-market.md
  - ../reference/roadmap.md
  - ../reference/project.md
---

# OTA release control — phased scope and design

This spec records the scope decisions made on 2026-09-25 for the OTA product (#99) and designs the parts that the [OTA hosting design](./2026-09-24-ota-design.md) does not cover. That document stays the design for Expo Updates hosting (phase 3 below). Where the two disagree, this one wins.

## 1. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Ship in five phases: **(1) gate existing OTA tools → (2) version policy and native force update → (3) Expo Updates hosting → (4) CodePush-compatible device layer → (5) crash-driven auto pause/rollback.** | Delivery is a commodity (Cloudflare self-host costs about $5–20/month at 1M MAU). The market lacks pre-push approval, customer-verifiable audit and token-less CI publishing, which phases 1–2 deliver with little new infrastructure. |
| D2 | CodePush compatibility covers **the three device endpoints and an import tool only**. No management API or CLI compatibility. | Management compatibility brings back long-lived tokens and ungated promotion. It would also cost another 3–4 weeks. |
| D3 | **Direction-aware approvals.** Changes that add risk go through a gate. Changes that remove risk apply immediately, are always audited, and need **post-hoc approval**. | Operators must never wait for an approver during an incident. Korean program-control rules require post-hoc approval for emergency changes ([market research §5](../research/codepush-market.md)). |
| D4 | Native force update is part of the OTA product, in phase 2. | Deploy, rollout, rollback and force update belong on one release screen, and they share version data. |
| D5 | First customer: Korean regulated or ISMS-P-certified React Native apps with 50K–2M MAU that already self-host OTA. | This is where the demand for approvals and audit is clearest. |
| D6 | Price governance, not delivery. | Competitors lock governance behind "Enterprise, contact sales". |

## 2. Direction rules (all phases)

One rule set applies to every release change. The classification is a pure function over the change, so it is unit-tested once and shared by phases 1–4.

| Change | Direction | Handling |
|---|---|---|
| Promote a release to a protected channel | tighten (adds risk) | gate approval |
| Increase a rollout percentage | tighten | gate approval |
| Resume a paused rollout | tighten | gate approval |
| Re-deploy after a rollback | tighten | gate approval |
| Raise minimum supported or recommended version, add a blocked version | tighten | gate approval |
| Weaken a channel's or app's approval policy | tighten | gate approval under the **current** policy |
| Pause a rollout | relax (removes risk) | immediate, audited, post-hoc approval |
| Roll back, roll back to embedded, disable a release | relax | immediate, audited, post-hoc approval |
| Lower minimum or recommended version, remove a blocked version | relax | immediate, audited, post-hoc approval |

**Post-hoc approval.** Every relax change creates an approval request in state `pending_review` that references the applied change. It uses the same requirements as the tighten path. Until it is approved, the release screen and the audit export flag it as an unreviewed emergency change. An unreviewed change never blocks operations; it is an evidence gap the team can see.

Implementation: the platform slice *approvals outside runs* (#114) provides `ApprovalService` and the vote policy extracted from `GateService`. This spec adds the `pending_review` state and the `review` kind to it.

## 3. Phase 1 — gate existing OTA tools

### Goal

Teams keep EAS Update, a hosted CodePush service (Bitrise, Codemagic, Revopush) or hot-updater. Mocco holds the tool's publishing credential and releases it only to a pipeline step that reached a resumed gate. Every release is in the audit chain. Nothing changes in the app.

### How it works

It reuses the existing credential broker unchanged in its decision logic:

```yaml
# .mocco.yml
version: 2
pipeline: ota-production
steps:
  - kind: step
    run: build-bundle
    executor: github-actions
    with: { workflow: ota-build.yml }
  - kind: gate
    name: prod
    resume: [{ role: mobile-release, count: 2 }]
    prevent_self: true
    reason_required: true
  - kind: step
    run: publish
    executor: github-actions
    with: { workflow: ota-publish.yml }
    credential: { provider: ota-eas, role: acme-production, ttl: 900, gate: prod }
```

The `publish` workflow calls `POST /api/ext/credentials` with its run token (the existing broker contract). If every broker check passes (step dispatched, pinned config, gate resumed, allowlist grant), the broker asks the **sealed-secret provider** for `ota-eas` / `acme-production`. That provider opens the stored token with SecretBox and returns it as the credential `value`. The workflow exports it (`EXPO_TOKEN`, `CODE_PUSH_ACCESS_KEY`, or the hot-updater storage credentials) and runs the tool's own CLI.

### Model

`mocco_ota_external_credentials`:

| Column | Notes |
|---|---|
| `id`, `workspace_id`, `project_id` | composite FK to `mocco_projects(id, workspace_id)` |
| `tool` | `eas` \| `codepush` \| `hot_updater` \| `generic` (constants in `@mocco/common/ota`) |
| `name` | unique per workspace. It becomes the broker `role` (for example `acme-production`). |
| `secret_sealed` | SecretBox envelope, AAD `mocco_ota_external_credentials:<id>` |
| `secret_fingerprint` | first 8 hex chars of SHA-256, for display only |
| `created_by_user_id`, `created_at`, `rotated_at` | |

The broker `provider` is `ota-<tool>`. The allowlist (`mocco_credential_grants`) works unchanged: a grant permits `(repo, pipeline, gate, provider, role)` with a `max_ttl`.

### Changes to existing code

- `CredentialProvider` becomes a registry keyed by provider id: the stub, later AWS STS, and the sealed-secret provider. The broker picks by `credential.provider`; an unknown provider is a DENY (fail-closed), recorded like the other reasons.
- The sealed-secret provider records `credential.issued` with the credential id and fingerprint, never the value (the existing audit rule).
- Creating, rotating and deleting an external credential are audited (`ota.credential.created|rotated|deleted`). The secret is write-only: the API never returns it. The UI shows the fingerprint and `hasSecret`.

### Limits (stated in the product, not hidden)

- **The token is static.** The ttl limits how long Mocco considers the grant valid. It does not expire the token itself, so a compromised runner that received it keeps it until the customer rotates it. Mitigations: publish from GitHub-hosted runners only, scope the tool's token as narrowly as the tool allows (per app or per deployment), and rotate on a schedule. The rotation reminder uses the job queue (#111) once it exists.
- **Direction rules are procedural here.** A publishing token can do anything the tool allows, so Mocco cannot enforce "rollback is the only thing this pipeline does". Relax actions run through a separate pipeline with no gate. It still gets the token only through the broker, its run is audited, and it creates a post-hoc review. Cryptographic enforcement of direction arrives with phase 3, where Mocco owns the channel state.
- Rollout percentages and pause are whatever the tool's CLI exposes.

## 4. Phase 2 — version policy and native force update

### Goal

Per store app: a minimum supported version (hard block), a recommended version (dismissible prompt), and blocked versions. Apps ask a public endpoint on launch and show the prompt. This works with or without Mocco-hosted OTA.

### Model

A policy applies to one `mocco_project_apps` row whose platform is `ios` or `android`, since store versions and store links are per platform. A React Native project registers its iOS and Android builds as two apps.

`mocco_app_version_policies` (one row per app):

| Column | Notes |
|---|---|
| `app_id` PK, `workspace_id`, `project_id` | composite FK to the app |
| `min_supported_version` | text, nullable. Below it → `hard`. |
| `recommended_version` | text, nullable. Below it → `soft`. Must be ≥ min. |
| `blocked_versions` | text[]. An exact match → `hard`. |
| `messages` | jsonb `{ [locale]: { title, body, action } }`, with an `en` entry required |
| `store_url` | text, nullable. Defaults from `store_app_id`. |
| `soft_prompt_interval_hours` | int, default 72 |
| `approval_policy` | jsonb `GateRequirements`, nullable. Null means tighten changes apply without approval (small teams). |
| `revision` | bigint, incremented on every change. It is the cache key. |
| `updated_at` | |

`mocco_app_version_policy_changes` (append-only history): `id`, `workspace_id`, `app_id`, `before` jsonb, `after` jsonb, `direction` (`tighten` \| `relax`), `actor_user_id`, `approval_request_id` (nullable), `reason`, `created_at`.

### Invariants

- Versions are dotted numeric (`^\d+(\.\d+){0,3}$`) and compare segment by segment, with missing segments treated as 0 (`2.3` equals `2.3.0`). One pure `compareVersions` in `@mocco/common`, with property tests.
- `recommended_version ≥ min_supported_version` when both are set (checked in the service and as a DB check on the parsed form, which is stored alongside).
- **Store-live check.** A tighten change to version X requires confirmation that X is live on the store. In v1 this is an explicit operator attestation, recorded in the change and the audit entry. Once store sync (#94) exists, it becomes an automatic check against the store's current version.
- A tighten change on an app with an `approval_policy` becomes an `ApprovalService` request whose pinned action is the full `after` policy. It applies only if the policy's `revision` has not moved since the request was made; otherwise the request is superseded.

### Public API

`GET /api/ext/v1/apps/{appId}/version-check?version=2.3.1&locale=ko`

```json
{ "status": "soft", "minSupportedVersion": "2.0.0", "recommendedVersion": "2.4.0",
  "message": { "title": "…", "body": "…", "action": "…" },
  "storeUrl": "https://apps.apple.com/app/id123456789", "promptIntervalHours": 72, "revision": 12 }
```

- `status` is one of `ok | soft | hard`. A malformed version is 400. An unknown app, or an app with no policy, returns `ok`, so a misconfigured app never locks users out.
- The response is `Cache-Control: public, max-age=60, stale-while-revalidate=300` and carries an `ETag` of the policy revision. It is safe to serve from a CDN because it contains nothing secret.
- v1 is keyed by the app id, a non-secret uuid, without an API key. When the public `/v1` key model (#113) lands, a publishable key becomes optional for rate-limit attribution; the endpoint stays usable without one.
- Unlike most `/v1` endpoints this one is unauthenticated. That is deliberate: the policy is shown to every user of the app anyway.

### Client

`@mocco/react-native-version` (pure JS, MIT, published with the SDK packaging slice #115):

```ts
const { status, message, openStore, dismiss } = useVersionPolicy({ appId, version: DeviceInfo.getVersion() });
```

It ships with a default modal: `hard` cannot be dismissed, and `soft` respects the prompt interval using AsyncStorage when present. On Android, an optional adapter uses Play In-App Updates (immediate for `hard`, flexible for `soft`). iOS has no equivalent API, so it uses the modal and the App Store link. Until the package ships, the endpoint is documented for teams to call directly.

### Console

The app page gets a **Version policy** panel: the current policy, a change form that labels each edit as tighten or relax before submitting, pending approvals, and history. Adoption preview ("raising the minimum to 3.0 blocks 7% of active users") needs version telemetry. It comes from the version-check requests themselves (counted per version per day, no device id stored), rolled up by the job queue.

## 5. Phase 3 — Expo Updates hosting

Designed in [the OTA hosting design](./2026-09-24-ota-design.md) (slices #126–#135). Changes from this spec:

- **Protocol-neutral domain.** `mocco_ota_apps` references a `mocco_project_apps` row instead of carrying its own identity, and gains `protocol` (`expo_updates` \| `codepush`). Channels, heads, rollouts, deployments and approvals are protocol-neutral. Only the servable artifact tables (`mocco_ota_updates`, `mocco_ota_signed_directives`) are Expo-specific, and phase 4 adds a sibling table rather than changing them.
- **Custom domains must serve at the root path**, because CodePush clients call `{serverUrl}v0.1/public/codepush/…`.
- Relax actions create post-hoc reviews (§2), in addition to the existing "stop kinds are never gated but always audited" invariant.
- The update-check response for a device whose binary is below the app's `min_supported_version` carries no update; the client is expected to show the phase 2 prompt.

## 6. Phase 4 — CodePush-compatible device layer

Scope, from [the technical research](../research/codepush-technical.md):

- The three unauthenticated device endpoints: `GET v0.1/public/codepush/update_check`, `POST v0.1/public/codepush/report_status/deploy`, and `POST v0.1/public/codepush/report_status/download`. Selection must match Microsoft's rules exactly, including "mandatory if any skipped release was mandatory" and binary version range matching.
- A per-channel deployment key (hashed at rest) in the CodePush shape. It is the device-side identifier only; it grants no management rights.
- Import: an existing CodePush deployment's history and current package, from a Codemagic/Bitrise/Revopush export or a self-hosted server's storage.
- **Integrity level.** CodePush signs package contents only. Which package is served, the mandatory flag and the rollout are unsigned, and replays of old signed packages are possible. So a protected channel on a `codepush` app requires the app to ship a `CodePushPublicKey`, and the console labels these apps as a lower integrity level.
- Migration path: teams that already run a CodePush server on a hostname they control can point it at Mocco without a store release. Everyone else changes the server URL and key in native config with one store release.
- Estimate: 3–4 engineer-weeks.

## 7. Phase 5 — crash-driven auto pause

When a candidate's adoption rises and its crash rate (from a Sentry or Crashlytics integration) exceeds a threshold relative to the active release, Mocco pauses the rollout automatically. This is a relax change, so it applies immediately and creates a post-hoc review. Automatic rollback (not only pause) is opt-in per channel. Details are deferred until the crash-data integration is designed.

## 8. Dependencies

| Needs | Phase | Status |
|---|---|---|
| Project/app entity (#108) | 1–5 | PR #242 |
| Approvals outside runs (#114) + `pending_review` | 1–5 | next in this stack |
| SecretBox (#110) | 1 | PR #248 |
| Public `/v1` surface on the ext app | 2 | v1 uses app id only; keys from #113 later |
| SDK packaging (#115) | 2 (client package), 3 | open |
| Job queue (#111) | 2 (telemetry rollup), 1 (rotation reminders) | open |
| Store sync (#94) | 2 (automatic store-live check) | later; v1 uses attestation |
| Object storage (#116), custom domains (#120) | 3, 4 | open |

## 9. Slices

In dependency order. Issue numbers are attached under #99.

1. `feat(platform)`: approvals outside runs with post-hoc review (#114, extended here).
2. `feat(ota)`: version policy domain, direction-aware changes and history.
3. `feat(ota)`: public version-check endpoint with caching and per-version counts.
4. `feat(ota)`: version policy console panel.
5. `feat(sdk)`: `@mocco/react-native-version` with the default modal and Play In-App Updates adapter (after #115).
6. `feat(credential)`: provider registry in the broker.
7. `feat(ota)`: external OTA credentials (sealed) and the sealed-secret provider (after #110).
8. `docs(ota)`: guides for gating EAS Update, hosted CodePush and hot-updater.
9. Phase 3 slices #126–#135, adjusted for the protocol-neutral domain.
10. `feat(ota)`: CodePush-compatible device endpoints and import.
11. `feat(ota)`: crash-driven auto pause (after a crash-data integration).

Phases 1 and 2 are independent of each other after slice 1. Phase 2 lands first in the stack because phase 1 waits on SecretBox.

## 10. Open questions

- Which EAS, Bitrise, Codemagic and hot-updater token types can be scoped per app or per channel, and which can be rotated through an API. Check each before writing the phase 1 guides.
- Whether the post-hoc review should expire into an escalation (for example a Slack reminder after 24 hours) or stay open indefinitely.
- Whether FSS or FSI examiners treat an OTA bundle push as an Art. 29 program change. Confirm with one Korean fintech security team before this appears in marketing.
- Whether version-check telemetry counts should be exposed to customers in phase 2 or only used for the adoption preview.
