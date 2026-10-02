---
title: Mocco-hosted OTA updates
description: How a project's React Native app becomes a Mocco-hosted OTA app served to the stock expo-updates client — the tables, the fixed device-facing URLs, signing certificates, channels and their protection, and the tRPC surface. Uploads, the manifest endpoint and promotions follow in later slices.
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
---

# Mocco-hosted OTA updates

> Phase 3 of the [OTA release control design](../specs/2026-09-25-ota-release-control-design.md): Mocco serves updates to the stock `expo-updates` client (ADR 0021), signed in the customer's CI (ADR 0022), with promotions to protected channels approved like a deploy (ADR 0020). This page covers setup (#127); uploads (#128), the manifest endpoint (#129) and promotions (#131, #132) build on it.

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

## Tables (migration 0022)

`mocco_ota_apps`, `mocco_ota_signing_certificates`, `mocco_ota_channels`, plus the tables the next slices fill: `mocco_ota_releases`, `mocco_ota_updates` (the exact signed manifest bytes, never rewritten; the id is the Expo update id from CI), `mocco_ota_signed_directives`, `mocco_ota_assets` (content-addressed by base64url SHA-256, linked to `mocco_objects`), `mocco_ota_update_assets`, `mocco_ota_channel_heads` (serving state per channel, platform and runtime version) and `mocco_ota_deployments` (append-only channel history). All are workspace-scoped with composite FKs.

## tRPC surface

`ota.hosting.apps.list | create`, `ota.hosting.certificates.list | add | retire` (add/retire owner/admin), `ota.hosting.channels.list | create | changePolicy`. All require the OTA product. Votes on pending channel-policy requests go through `approval.vote`.
