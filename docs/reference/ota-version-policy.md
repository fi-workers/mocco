---
title: OTA version policy and native force update
description: Per-store-app minimum, recommended and blocked versions; how each change is classified and gated; the pure version functions; and the tRPC surface.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, ota, version-policy, force-update, approvals]
related:
  - ../specs/2026-09-25-ota-release-control-design.md
  - ./approvals.md
  - ./project.md
code_refs:
  - packages/common/src/ota.ts
  - packages/backend/src/domain/ota/VersionPolicyService.ts
  - packages/backend/src/domain/ota/instance.ts
  - packages/backend/src/transport/trpc/routers/ota.ts
  - packages/backend/src/domain/ota/VersionCheckService.ts
  - packages/backend/src/transport/ext/app.ts
---

# OTA version policy and native force update

> Phase 2 of the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md). An app on an old binary is told to update from the store: **hard** (it cannot continue), **soft** (a dismissible prompt), or **ok**. The React Native package is the next slice; this page covers the policy, how it changes, and the public check apps call.

## Scope

A policy belongs to one project app whose platform is `ios` or `android` (a store build). Other platforms get `NotAStoreAppError` (`BAD_REQUEST`). All procedures require the OTA product to be enabled (`productProcedure(Products.ota)`, `FORBIDDEN` otherwise) and the project to belong to the workspace.

## Rules and evaluation (`@mocco/common/ota`)

- Versions are 1–4 dot-separated integers. `compareVersions` compares segment by segment; missing segments count as 0 (`2.3` = `2.3.0`).
- `evaluateVersionPolicy`: a blocked version or one below `minSupportedVersion` → `hard`; below `recommendedVersion` → `soft`; else `ok`.
- The rules schema requires an `en` message and `recommendedVersion ≥ minSupportedVersion`.

## Change classification

`classifyPolicyChange(before, after)` returns `tighten`, `relax` or `none`. Any tightening component makes the whole change `tighten`.

| Tightens | Relaxes | Neither |
|---|---|---|
| Raising or newly setting the minimum or recommended version | Lowering or clearing it | Copy (`messages`) edits |
| Adding a blocked version | Removing a blocked version | The soft-prompt interval |
| Changing the store URL | | |
| Changing an existing approval policy (including removing it) | | |

## How a change is applied

| Direction | Policy has an `approvalPolicy` | Result |
|---|---|---|
| `tighten` | yes | Older pending pre-approvals for the app are superseded; a new `pre_approval` is opened under the **current** policy → `pending_approval`. On approval, the handler applies the pinned rules. |
| `relax` | yes | Applied at once, and a `review` request is opened for the post-hoc review. |
| any | no | Applied at once. |
| `none` | yes | Applied at once, no request. |

- **Store-live attestation.** Raising a version floor requires `storeLiveAttested: true` (`StoreLiveAttestationRequiredError` otherwise). It is recorded with the change. The automatic check against the store replaces it once store sync exists.
- **Optimistic concurrency.** Every apply writes `revision + 1` only if `revision` is unchanged. A direct change that loses the race gets `VersionPolicyConflictError`. An approval that finds the policy moved since the request is **not** applied; it is audited as `ota.version_policy.approval_stale`.
- **History.** Every applied change is a row in `mocco_app_version_policy_changes` with `before`, `after`, `direction`, the actor, the reason, and the approval that applied it (if any). Each one also appends `ota.version_policy.changed` to the audit chain.

## tRPC surface

`ota.versionPolicy.get | change | history`, each taking `workspaceId`, `projectId`, `appId`. `change` takes the full new `rules`, an optional `reason`, and `storeLiveAttested`, and returns `{ outcome, policy, requestId }` where `requestId` is the pre-approval (`pending_approval`) or the post-hoc review (a relaxing change).

## Public version check

`GET /api/ext/v1/apps/{appId}/version-check?version=2.3.1&locale=ko-KR` on the Hono ext surface.

- **Unauthenticated by design.** The policy is shown to every user of the app, so it is not secret. The app id (a uuid) is the only key, and the response contains nothing workspace-scoped.
- **Response:** `{ status, minSupportedVersion, recommendedVersion, message, storeUrl, promptIntervalHours, revision }` (`versionCheckResponseSchema`). `message` is null when the status is `ok`. It is picked by the exact locale, then its language (`ko-KR` → `ko`), then `en`.
- **Fail-open for users:** an unknown app, or one without a policy, answers `ok` with `revision: 0`, so a misconfiguration never locks users out.
- **Store link:** the policy's `storeUrl`, or else a default built from the app. iOS uses `https://apps.apple.com/app/id<storeAppId>`; Android uses `https://play.google.com/store/apps/details?id=<storeAppId or bundleId>`.
- **Caching:** `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300`, a strong `ETag` over the body (a matching `If-None-Match` gets 304), and `Access-Control-Allow-Origin: *`. A policy change reaches devices within about a minute.
- **Validation:** a malformed version, locale or app id is 400.
