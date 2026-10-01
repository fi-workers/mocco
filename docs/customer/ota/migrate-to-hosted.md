---
title: Move to Mocco-hosted OTA from CodePush or EAS Update
description: What changes when you move an app from App Center CodePush or EAS Update to Mocco-hosted updates — the client, the config, signing, channels, CI and the cut-over order.
type: guide
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [customer, ota, codepush, eas-update, migration, guide]
related:
  - ./hosted-updates.md
  - ./overview.md
---

# Move to Mocco-hosted OTA

Mocco serves the Expo Updates protocol, so the app runs the stock `expo-updates` client. Moving is a new binary with a new update URL; updates can't move to an installed binary that still points elsewhere. Plan for both services to run until most users have the new binary.

## From EAS Update

EAS Update already uses `expo-updates`, so the code stays the same.

| EAS Update | Mocco |
|---|---|
| `updates.url` `https://u.expo.dev/<project>` | the manifest URL from **OTA hosting** (`mocco-ota init` writes it) |
| `eas update --channel` | `mocco-ota publish --channel` (or the `ota-publish` action) |
| Channels and branches | Channels; a release is promoted between channels, never re-uploaded |
| Code signing (optional) | Required: `mocco-ota init` makes the key and certificate |
| `eas update:rollback` | **Roll back** (pre-signed, instant) or **Roll back to embedded** |
| Rollouts | `--rollout <percent>` and the channel controls |

Keep `runtimeVersion` as it is: Mocco serves updates per platform and runtime version, like EAS.

## From App Center CodePush

CodePush needs a different client: replace `react-native-code-push` with `expo-updates` (`npx install-expo-modules` adds Expo modules to a bare app, then `npx expo install expo-updates`).

| CodePush | Mocco |
|---|---|
| Deployment keys (`Staging`, `Production`) | Channels in `expo-channel-name`; protect `production` |
| `appcenter codepush release-react` | `mocco-ota publish --channel staging` |
| `promote Staging Production` | **Promote** (an approval on a protected channel) |
| `--rollout 20` | `--rollout 20` |
| `--mandatory` and `installMode` | `--mandatory`; the app applies it at the next safe point |
| `rollback` | **Roll back** (instant, signed in advance) |
| Target binary version (`--targetBinaryVersion`) | `runtimeVersion` (set it in `app.json`, e.g. the `appVersion` policy) |

Remove the `codePush()` wrapper and its `checkFrequency`; `expo-updates` checks on launch by default.

## Cut-over order

1. Set up hosting ([Host OTA updates on Mocco](./hosted-updates.md)): the app, the certificate, channels and CI.
2. Ship a binary built with the Mocco config. Keep publishing to the old service for older binaries.
3. Publish each OTA release to both while the old binary is still in use. Mocco's adoption numbers show how many devices run the new binary's releases.
4. When the old binary's share is negligible, stop publishing to the old service.
