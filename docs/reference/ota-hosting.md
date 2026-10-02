---
title: Mocco-hosted OTA updates
description: How a project's React Native app becomes a Mocco-hosted OTA app served to the stock expo-updates client — the fixed device-facing URLs, signing certificates, channels and their protection, uploads from CI with the mocco-ota CLI, promotion to open channels, the manifest and asset endpoints, and the tRPC surface. Gated promotion, rollout and rollback follow.
type: reference
status: active
created: 2026-10-01
updated: 2026-10-01
confidence: high
owner: andrea
tags: [reference, ota, expo-updates, signing, channels]
related:
  - ../adr/0020-approvals-outside-pipeline-runs.md
  - ../adr/0021-ota-client-is-expo-updates-protocol-v1.md
  - ../adr/0022-ota-signing-key-stays-in-ci.md
  - ../specs/2026-09-24-ota-design.md
code_refs:
  - packages/backend/src/domain/ota/OtaHostingService.ts
  - packages/backend/src/domain/ota/SigningService.ts
  - packages/backend/src/domain/ota/manifest/signature.ts
  - packages/backend/src/transport/trpc/routers/ota-hosting.ts
  - packages/common/src/ota-hosting.ts
  - packages/backend/src/domain/ota/UploadService.ts
  - packages/backend/src/transport/ext/v1/ota-uploads.ts
  - packages/ota-cli/src/publish.ts
  - packages/backend/src/domain/ota/OtaChannelService.ts
  - packages/backend/src/domain/ota/UpdateCheckService.ts
  - packages/backend/src/domain/ota/serving/select.ts
  - packages/backend/src/transport/ext/v1/ota-manifest.ts
  - packages/backend/src/domain/ota/TrustPolicyService.ts
  - packages/backend/src/domain/integration/github/oidc.ts
  - packages/backend/src/domain/ota/providers/mocco-ota.ts
  - actions/ota-publish/action.yml
---

# Mocco-hosted OTA updates

> Phase 3 of the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md): Mocco serves updates to the stock `expo-updates` client (ADR 0021), signed in the customer's CI (ADR 0022), with promotions to protected channels approved like a deploy (ADR 0020). This page covers setup (#127), uploads (#128), promotion and serving (#129), trusted publishing (#130), gated promotion (#131), staged rollout, pause and rollback (#132), adoption metrics (#133), and the release and channel pages (#134). Customer guides: [Host OTA updates on Mocco](../customer/ota/hosted-updates.md) and [Move to Mocco-hosted OTA](../customer/ota/migrate-to-hosted.md).

## OTA apps

An OTA app hosts updates for one of a project's apps whose platform is **React Native** (one OTA app serves both iOS and Android). Creating it fixes two URLs for the life of the app, because they end up in binaries and in signed manifests:

- **Manifest URL** (`updates.url`): `<public API base>/ota/apps/{id}/manifest`.
- **Asset base URL**: `<public API base>/ota/apps/{id}/assets`. Asset URLs in every signed manifest start with it; the asset route redirects to the object store or CDN, so manifests don't depend on the storage setup.

The public API base is `https://<PUBLIC_API_DOMAIN>/v1` when that host is set, else `<app origin>/api/ext/v1`. `*.localhost` hosts are plain http, like `localhost`. Apps require signed updates (`signing_required`) by default.

The console's **OTA hosting** tab shows the `expo.updates` block to paste into `app.json`: the URL, `requestHeaders: { "expo-channel-name": … }`, `codeSigningCertificate` and `codeSigningMetadata: { keyid: "root", alg: "rsa-v1_5-sha256" }`.

## Signing certificates

The app embeds an X.509 certificate; the customer's CI holds the private key. Mocco stores the certificate PEM, its subject, expiry, keyid (default `"root"`, expo-updates' default) and the SHA-256 of its public key, and accepts it only if it is an unexpired RSA certificate. Several certificates can be active at once (rotation needs a new binary, and old binaries still verify against the old certificate); retiring one stops accepting its signatures. Adding and retiring are owner/admin-only and audited (`ota.cert.added`, `ota.cert.retired`).

`SigningService.verify(appId, body, expo-signature)` parses the SFV header (`sig`, `keyid` default `"root"`, `alg`), and checks `rsa-v1_5-sha256` over the exact body against the app's active certificates for that keyid. Uploads use it before anything is stored.

## Channels and protection

A channel is what a build reads updates from (`expo-channel-name`). A **protected** channel has a `GateRequirements` policy for promotions; the database enforces that a channel is protected exactly when it has a policy. Changing protection follows ADR 0020:

| Change | Result |
|---|---|
| Protect an open channel | Applied at once |
| Change or remove an existing protection | A `pre_approval` (`ota.channel_policy`) under the **current** policy; older pending requests for the channel are superseded. On approval the handler applies the pinned policy, unless the channel changed since (then `ota.channel.policy_approval_stale` is audited) |

Every change is audited as `ota.channel.policy_changed` (with the approval id when there is one). Channel creation is `ota.channel.created`.

## Uploads from CI

CI publishes with `@mocco/ota-cli` (`mocco-ota`):

1. **`mocco-ota init --manifest-url <url>`**, once, in the Expo project. It makes an RSA key pair and a self-signed certificate (`keys/private-key.pem`, git-ignored, and `certs/certificate.pem`), and writes the `expo.updates` block into `app.json`. Register the certificate in the console and store the private key as the CI secret `MOCCO_OTA_SIGNING_KEY`.
2. **`mocco-ota publish`** with `MOCCO_API_KEY` set to a secret key with `ota:write`. It runs `expo export` (or uses `dist/` with `--skip-export`), reads the API base and app id from `updates.url` and the runtime version from `app.json` (a literal or the `appVersion` policy; otherwise pass `--runtime-version`), then:
   - exchanges the key for a 15-minute upload session (`ota.upload.authorized`);
   - declares the release and its assets by base64url SHA-256. Mocco answers with presigned PUTs for **only the hashes it doesn't already store** (assets are deduplicated per app), the asset base URL, and the current head of each channel on that runtime;
   - signs one manifest per platform (`extra.expoClient` carries the static Expo config, `extra.mocco` the release id, git SHA and `mandatory`), a republish of each channel head dated 1 ms later, and a `rollBackToEmbedded` directive, then finalizes.

**Finalize checks every body before storing any:** the manifest shape, `runtimeVersion` matches the release, `createdAt` is at most 10 minutes ahead of and 24 hours behind the server clock, every asset URL is `${assetBaseUrl}/${hash}`, every asset's bytes are stored with the declared size and type, a republish has exactly its target's assets and a later `createdAt`, and the signature verifies against an active certificate for its keyid (required on `signing_required` apps). A refusal is `400 upload_rejected` whose `detail` the CLI prints as is; nothing is stored, and the same release can be finalized again once fixed. A success is audited as `ota.release.uploaded` with the git SHA and principal.

The release is then `verifying` until the **`ota.verifyAssets`** job re-hashes each new asset from storage. All match → `ready`, the only status a release can be promoted from. A mismatch or missing bytes → `failed` (`ota.release.failed`); the bad bytes are deleted, so the next upload of that hash is asked for again. The daily `ota.uploadSessions.prune` job drops expired sessions and fails releases whose session expired before finalize.

The console's **Releases** list shows each release's status, platforms, download size, git SHA and uploader.

## Trusted publishing and Mocco runs

CI can get an upload session three ways, and none needs more than 15 minutes; every session is stored as a token hash and audited as `ota.upload.authorized`:

| From | How | Principal | May promote to |
|---|---|---|---|
| A secret API key with `ota:write` | `POST /v1/ota/apps/{id}/upload-sessions` | `apikey:<id>` | any unprotected channel |
| A **GitHub Actions OIDC token** (trusted publishing) | `POST /v1/ota/auth/oidc {appId, token}` | `github:repo:<id>:ref:<ref>` | the trust policy's `allowed_channels` |
| A **gated Mocco run step** | the credential broker, provider `mocco-ota`, role = the OTA app id | `mocco:run:<runId>` | any unprotected channel |

**Trust policies** (OTA hosting → Trusted publishing; owners and admins) name a GitHub repository by its numeric id, so a rename or a fork can't match, plus a ref pattern (`refs/heads/main`, or `*` as a wildcard: `refs/tags/v*`). They can optionally pin the workflow (`job_workflow_ref`) and the environment. They also list the unprotected channels sessions may promote to. The exchange verifies the token against GitHub's JWKS (issuer `https://token.actions.githubusercontent.com`, audience Mocco's public API origin, expiry), then takes the oldest matching policy. Every refusal is the same `403` "OIDC token not accepted"; the reason is logged and audited as `ota.upload.denied`.

In a workflow, `fi-workers/mocco/actions/ota-publish` runs `mocco-ota publish --oidc` (the default in Actions when `MOCCO_API_KEY` is unset). The job needs `permissions: id-token: write` and the signing key in `MOCCO_OTA_SIGNING_KEY`. With a `channel` it promotes through the session once the release is verified. The console shows the workflow step under the policies. The action runs the published `@mocco/ota-cli`, which ships with SDK packaging.

**From a Mocco pipeline**, a step can request the credential `{ provider: mocco-ota, role: <OTA app id>, ttl, gate }`. The broker issues it only after its usual checks (run token, step dispatched, gate resumed, workspace grant), and the provider mints a run-bound session for an app in the run's workspace.

## Promotion

Promoting a `ready` release to a channel points that channel's heads (one per platform and runtime version) at the release's updates. It is refused when the release isn't ready, and when the release is **older** than what the channel serves on a platform: devices load only a newer `commitTime`, so an older release would reach no one, and going back is a rollback. Promoting what a channel already serves changes nothing. Each change appends a `promote` deployment and is audited as `ota.channel.changed` with the actor (a user or `apikey:<id>`, `github:…`, `mocco:run:<id>`).

- **An open channel** changes at once.
- **A protected channel** gets a `pre_approval` request (`ota.channel_change`) under its current policy, pinned to the release, with one pending request per channel (a newer request supersedes the older one). The approval handler is the only way a protected head changes: it re-checks the release, applies the pinned promotion, and records the approvers and their roles on `ota.channel.changed` and the request id on the deployment. If the release can no longer be promoted when the approval lands (it was disabled, or the channel moved past it), nothing changes and `ota.channel.change_failed` is audited. Changing the channel's protection supersedes its pending promotions.
- **Who requested it** is who can't approve it under `prevent_self`: the console user, or for CI the person the session acts for. That is the API key's creator, or the run's trigger for a broker session; a GitHub OIDC session acts for no one.
- **Notifications:** `ota.promotion.requested`, `ota.promotion.approved` and `ota.promotion.rejected` events (facts `app`, `channel`, `release`) reach notification channels whose rules match; the Mocco preset includes them.

Promote from the console (**Promote** on a ready release, or **Request approval** when the channel is protected), with `mocco-ota promote --release <id> --channel <name> [--wait]`, or with `mocco-ota publish --channel <name> [--wait]`, which waits until the release is verified (and, with `--wait`, for the approval). `/v1` answers `201` when heads changed, `202` with `requestId` when approval is pending, and `200` for a no-op; `GET …/promotions/{requestId}` reports the request's state. The channel row shows what it serves per platform and each waiting request: the release, its size, its git SHA, the assets devices would download compared with what the channel serves now, the reason, and what the policy needs.

## Rollout, pause and rollback

A promotion below 100% starts a **staged rollout**: the release becomes the head's candidate for that share of devices (basis points; a device's bucket is the SHA-256 of the head's salt and its `EAS-Client-ID`, so raising the share only adds devices), while everyone else keeps the active update.

| Action | Gated on a protected channel | What it does |
|---|---|---|
| Promote at a share < 100% (`rollout`) | yes | The release becomes the candidate for that share |
| Set share | yes | Changes the share; 100% completes |
| Complete | yes | The candidate becomes active (and the old active its `previous`) |
| Resume | yes | Lifts a pause |
| **Pause** | never | Freezes new adoption: devices not on the candidate get the active update; devices already on it keep it |
| **Roll back** (per platform) | never | Serves the pre-signed republish of what the head served before, re-dated after the bad update, so devices on it take it at once. During a rollout this is the abort: the republish of the active update, valid for devices on the candidate |
| **Roll back to embedded** (per platform) | never | Serves the bad update's pre-signed `rollBackToEmbedded` directive |

A rollback needs the republish the CLI pre-signed when the bad release was uploaded (for each channel head on its runtime). Without one (a channel's first release, or a second rollback in a row), the refusal says so and points at rolling back to embedded or publishing a fix. Each action writes a deployment (`rollout`, `pause`, `resume`, `complete`, `rollback`, `rollback_embedded`, with the share before and after) and an `ota.channel.changed` audit entry. The console shows each head's active and candidate release, the share and whether it's paused, a head that was rolled back ("Rolled back to …") or serves the embedded bundle, and the controls that apply. From CI: `mocco-ota promote --rollout 10`, `mocco-ota publish --channel staging --rollout 10`, `mocco-ota pause --channel <name>`, `mocco-ota rollback --channel <name> [--platform ios] [--to-embedded]`.

## Adoption metrics

- **Devices.** Each update check with an `EAS-Client-ID` updates the install's row in `mocco_ota_devices`: platform, runtime, channel, the update it runs (`expo-current-update-id`) and its embedded one, first and last seen. The id is stored only as the SHA-256 of a per-app pepper (`mocco_ota_apps.device_pepper`) and the id; no IP address is stored. Sightings are deduplicated in memory (the same device on the same update within 10 minutes is written once) and written in batches after the response (`waitUntil`), so the check itself does no extra database work (measured locally: p95 unchanged within noise).
- **Client events.** `POST /v1/ota/apps/{id}/events` takes up to 50 events (`launched`, `emergency_launch`, `error`, each with the update id and optional bounded detail) from one device, at most 16 KB, rate-limited per IP; it answers 202 (also for an unknown app). `<MoccoOta>` from `@mocco/react-native/ota` sends them.
- **Rollup.** The hourly `ota.rollupMetrics` job writes `mocco_ota_adoption_daily` for yesterday and today: per update, the devices last seen on it, the ones first seen that day, and the emergency launches. When a release's emergency launches today reach 5% of its devices (and at least 5), it publishes `ota.emergency_launch.spike` (once per update and day), which the Mocco notification preset includes. The daily `ota.metrics.prune` job drops events and devices older than 90 days.
- **Console.** Each release shows its devices in the last 24 hours, emergency launches and a 14-day bar per day (red on days with emergency launches); each channel head shows its devices and, during a rollout, how many run the candidate; the Releases header shows monthly active devices (`OtaMetricsService.monthlyActiveDevices`, the MAU meter for billing once metering lands).

## Serving devices

`GET /v1/ota/apps/{id}/manifest` speaks Expo Updates protocol v1 to the stock client. It reads `expo-protocol-version` (only `1`, else 400), `expo-platform` and `expo-runtime-version` (required, else 400), `expo-channel-name`, `EAS-Client-ID` and `expo-current-update-id`. Then:

1. **No head** for the app, channel, platform and runtime (including an unknown app or channel): **204** with `expo-protocol-version: 1`. Never 404, so apps can't be enumerated and a misconfigured build keeps its embedded bundle.
2. A head serving a `rollBackToEmbedded` directive: the **directive** part.
3. A device already on the candidate: **204** (it keeps it while paused, or after the share was lowered).
4. The **candidate** for devices whose rollout bucket (SHA-256 of salt and `EAS-Client-ID`, mod 10 000) is below the rollout share and the head isn't paused; everyone else gets the **active** update. A device without `EAS-Client-ID` is always in the control group.
5. Already running the target: **204**. Otherwise, **200** `multipart/mixed` with the `manifest` part, carrying the exact signed bytes and their `expo-signature` header, plus an `extensions` part. A client that accepts only JSON gets `application/expo+json` with `expo-signature` as a response header (and 406 for a directive).

Responses carry `expo-sfv-version: 0` and `cache-control: private, max-age=0`. Each head's serving state is cached in-process for 5 seconds, including "nothing to serve", so a burst of checks costs one query per head. A promotion invalidates the cache at once in the instance that made it; other instances catch up within the TTL.

`GET /v1/ota/apps/{id}/assets/{hash}` (the URL inside every signed manifest) redirects (302) to the verified bytes in the store: the CDN or bucket URL, or the filesystem driver's route. Unknown or unverified hashes are 404.

## Console pages

The OTA hosting tab links each channel to its page (`…/ota-hosting/channels/{id}?app=&platform=&range=`): what each head serves and rolls out with its controls and reach, the waiting requests, and its history from `mocco_ota_deployments` (actor, release, share change, approval, reason) for 7 days, 30 days or all. Platform and range are URL state. Each release has a page (`…/ota-hosting/releases/{id}?app=`): its signed updates including the pre-signed rollbacks, the heads serving it, its adoption, its approval requests and a Promote control. Each certificate shows the runtime versions that depend on it: finalize records which certificate verified each update (`mocco_ota_updates.certificate_id`). A release published with `--mandatory` carries `extra.mocco.mandatory`, which `useMoccoUpdate()` from `@mocco/react-native/ota` applies at the next safe point (when the app returns to the foreground). The `@mocco/react-native` Expo config plugin writes the same `expo.updates` block as `mocco-ota init`.

## Tables (migrations 0022–0029)

`mocco_ota_apps`, `mocco_ota_signing_certificates`, `mocco_ota_channels`, `mocco_ota_upload_sessions` (token hash only, one release per session, its trust policy and allowed channels), `mocco_ota_trust_policies`, plus the tables the next slices fill: `mocco_ota_releases`, `mocco_ota_updates` (the exact signed manifest bytes, never rewritten; the id is the Expo update id from CI), `mocco_ota_signed_directives`, `mocco_ota_assets` (content-addressed by base64url SHA-256, linked to `mocco_objects`), `mocco_ota_update_assets`, `mocco_ota_channel_heads` (serving state per channel, platform and runtime version) and `mocco_ota_deployments` (append-only channel history), `mocco_ota_devices`, `mocco_ota_client_events` and `mocco_ota_adoption_daily`. All are workspace-scoped with composite FKs.

## tRPC surface

`ota.hosting.metrics.adoption | channelReach`, `ota.hosting.apps.list | create`, `ota.hosting.releases.list | get`, `ota.hosting.certificates.usage`, `ota.hosting.channels.timeline`, `ota.hosting.trustPolicies.list | create | delete` (create and delete owner/admin), `ota.hosting.certificates.list | add | retire` (add/retire owner/admin), `ota.hosting.channels.list | create | changePolicy | heads | previewPromotion | promote | changeRollout | stop`. All require the OTA product. Votes on pending channel-policy requests go through `approval.vote`.
