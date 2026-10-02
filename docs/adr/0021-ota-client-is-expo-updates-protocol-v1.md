---
title: The OTA client contract is the Expo Updates protocol v1
description: Mocco-hosted OTA updates are served to the stock expo-updates client over the public Expo Updates protocol v1 (multipart manifest or directive parts, SFV expo-signature, strict commitTime ordering, 204 for no update), instead of a Mocco SDK or CodePush-compatible management; the protocol facts Mocco relies on are recorded with their expo-updates source locations.
type: adr
status: draft
created: 2026-10-01
updated: 2026-10-01
confidence: high
owner: andrea
decision_date: 2026-10-01
stakeholders: [andrea]
tags: [adr, ota, expo-updates, protocol, react-native]
related:
  - ../specs/2026-09-24-ota-design.md
  - ../specs/2026-09-25-ota-release-control-design.md
  - ./0022-ota-signing-key-stays-in-ci.md
---

# ADR 0021 — The OTA client contract is the Expo Updates protocol v1

## Context

Hosting OTA updates (phase 3 of the release control design) needs a client on the device that downloads, verifies and launches a JavaScript bundle. Three options: our own native SDK, CodePush compatibility, or the public Expo Updates protocol with the stock `expo-updates` module. A native SDK is a long-lived maintenance burden on two platforms; CodePush's protocol signs only package contents, not which package is served or the rollout (see the [technical research](../research/codepush-technical.md)), and its management API would bring back long-lived tokens. The Expo protocol is a published spec with a maintained native client used by EAS Update, including code signing and directives.

## Decision

1. **Serve the stock `expo-updates` client over protocol v1.** The manifest URL is `GET /api/ext/v1/ota/apps/{appId}/manifest`, set in the app's `updates.url`. Bare React Native apps install `expo-updates` (with `expo-modules-core`); no Mocco native code. Protocol 0 clients are not supported. The minimum is expo-updates 0.17.0, which added protocol 1, the rollback directive and 204 support.
2. **CodePush compatibility stays phase 4**, limited to the device endpoints (release control design §6), for teams migrating without a store release.

## Protocol facts Mocco relies on

Read from expo/expo `main` (`packages/expo-updates`, expo-updates 58.0.12, 2026-10-01), the [protocol spec](https://docs.expo.dev/technical-specs/expo-updates-1/), and expo/custom-expo-updates-server. Paths are under `packages/expo-updates/`.

- **Request headers** (`android/.../loader/FileDownloader.kt` `createRequestForRemoteUpdate`; `ios/EXUpdates/AppLoader/FileDownloader.swift` `setManifestHTTPHeaderFields`): `Accept: multipart/mixed,application/expo+json,application/json`, `Expo-Platform`, `Expo-Protocol-Version: 1`, `Expo-Runtime-Version`, `EAS-Client-ID`, `expo-expect-signature` (only with code signing), plus `Expo-Current-Update-ID`, `Expo-Embedded-Update-ID` and `Expo-Recent-Failed-Update-IDs`. There is no built-in channel header: the channel arrives through the app's `updates.requestHeaders` (`expo-channel-name`), which the client applies after its own headers.
- **`EAS-Client-ID`** is a random UUID per install, sent unconditionally, bare apps included (`expo-eas-client` `EASClientID.kt` / `EASClientID.swift`). It changes when app data is lost. Mocco uses it for rollout buckets and adoption, hashed.
- **Response:** `multipart/mixed` with parts named `manifest`, `extensions`, `directive` (and `certificate_chain`); zero parts means no update. Required response headers: `expo-protocol-version: 1`, `expo-sfv-version: 0`, and a short `cache-control` (`private, max-age=0`).
- **Signature:** the `expo-signature` part header is an SFV dictionary with `sig` (base64, required), `keyid` (default `"root"`) and `alg` (default and only supported value `rsa-v1_5-sha256`) (`codesigning/SignatureHeaderInfo.kt`, `CodeSigningAlgorithm.kt`). The client verifies `SHA256withRSA` over the part body bytes exactly. Without a certificate chain in the response, the response `keyid` must equal the app's configured `codeSigningMetadata.keyid`.
- **Ordering:** `createdAt` becomes `commitTime`, and a new update is loaded only if `newUpdate.commitTime.after(launchedUpdate.commitTime)`, strictly later (`selectionpolicy/LoaderSelectionPolicyFilterAware.kt` `shouldLoadNewUpdate`; same on iOS). This is why rollbacks are republishes with a newer `createdAt` (ADR 0022) and why a far-future `createdAt` must be refused at upload.
- **Directives:** `{"type":"noUpdateAvailable"}` and `{"type":"rollBackToEmbedded","parameters":{"commitTime":"<ISO>"}}` (`loader/RemoteUpdate.kt` `UpdateDirective.fromJSONString`). A rollback is accepted when nothing is launched, the launched update fails the filters, or `directive.commitTime` is strictly after the launched update's `commitTime` (`shouldLoadRollBackToEmbeddedDirective`). An unsigned directive part is rejected under code signing.
- **204:** with `expo-protocol-version` greater than 0 on the response, a 204 or empty body is "no update available", and no signature check runs on that path (`parseRemoteUpdateResponse`). An unsigned 204 is therefore accepted with code signing enforced, as long as it carries `expo-protocol-version: 1`.
- **Assets:** `hash` is base64url SHA-256 without padding (checked by the client), plus `key`, `contentType`, `fileExtension` and `url`.

## Consequences

- No native code to maintain; apps get the same client EAS Update uses, including bsdiff later.
- The manifest URL is baked into binaries, so it is a permanent contract. It can move to a dedicated host by rewrite, never by changing the path.
- "No update" is a 204 with protocol headers; a signed `noUpdateAvailable` directive is optional. Unknown apps, channels and runtimes also get 204, so apps can't be enumerated and a misconfigured build keeps running.
- The keyid Mocco expects defaults to `"root"`, matching the client; apps that set another `keyid` register their certificate under it.
- Still to run once on devices (an Android emulator and an iOS simulator): a signed staging update installs and a tampered one is rejected, and the directive behaviour above holds end to end.
