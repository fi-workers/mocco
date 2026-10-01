---
title: Mocco-hosted OTA updates
description: How a project's React Native app becomes a Mocco-hosted OTA app served to the stock expo-updates client — the fixed device-facing URLs, signing certificates, channels and their protection, uploads from CI with the mocco-ota CLI, and the tRPC surface. The manifest endpoint and promotions follow in later slices.
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
---

# Mocco-hosted OTA updates

> Phase 3 of the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md): Mocco serves updates to the stock `expo-updates` client (ADR 0021), signed in the customer's CI (ADR 0022), with promotions to protected channels approved like a deploy (ADR 0020). This page covers setup (#127) and uploads (#128); the manifest endpoint (#129) and promotions (#131, #132) build on it.

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

## Tables (migrations 0022–0023)

`mocco_ota_apps`, `mocco_ota_signing_certificates`, `mocco_ota_channels`, `mocco_ota_upload_sessions` (token hash only, one release per session), plus the tables the next slices fill: `mocco_ota_releases`, `mocco_ota_updates` (the exact signed manifest bytes, never rewritten; the id is the Expo update id from CI), `mocco_ota_signed_directives`, `mocco_ota_assets` (content-addressed by base64url SHA-256, linked to `mocco_objects`), `mocco_ota_update_assets`, `mocco_ota_channel_heads` (serving state per channel, platform and runtime version) and `mocco_ota_deployments` (append-only channel history). All are workspace-scoped with composite FKs.

## tRPC surface

`ota.hosting.apps.list | create`, `ota.hosting.releases.list`, `ota.hosting.certificates.list | add | retire` (add/retire owner/admin), `ota.hosting.channels.list | create | changePolicy`. All require the OTA product. Votes on pending channel-policy requests go through `approval.vote`.
