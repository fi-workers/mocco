---
title: Gate CodePush
description: Publish CodePush releases (Revopush, Codemagic, Bitrise or a self-hosted code-push-server) only after a Mocco gate is approved, with the access key Mocco releases to the publishing step.
type: guide
status: active
created: 2026-09-27
updated: 2026-10-04
confidence: medium
owner: andrea
tags: [customer, ota, codepush, guide]
related:
  - ./pipeline.md
---

# Gate CodePush

After Microsoft retired App Center, teams moved to hosted CodePush services or ran Microsoft's open-sourced server. Each has its own CLI, and each publishes with an access key. Mocco holds that key and releases it to your publishing step after the gate. Set up [Release a token to your pipeline](./pipeline.md) first; this page covers the key and the commands for each service.

Store the key in Mocco's **OTA tokens** page with the tool **CodePush (hosted)**, for example as `acme-production`. Its provider id is `ota-codepush`. The released value is in `$OTA_TOKEN` in the publishing job.

## Revopush

Create an access key in Revopush under **Settings**, then **Add new key**. Keys belong to your account and expire after 60 days by default. See [Revopush CI setup](https://revopush.org/ci-cd-automation-with-bitrise-codepush).

```bash
npx @revopush/code-push-cli login --accessKey "$OTA_TOKEN"
npx @revopush/code-push-cli release-react <app> android -d Production --description "${GITHUB_SHA}"
```

Roll back with `revopush rollback <app> Production`. See [releasing](https://docs.revopush.org/cli/releasing-updates) and [rolling back](https://docs.revopush.org/cli/rolling-back-updates).

## Codemagic CodePush

Generate a key under **OTA Updates**, then **Manage Access Keys**. You choose its expiry, it is shown once, and **Revoke access** in the same place revokes it. See [Codemagic CodePush security](https://docs.codemagic.io/rn-codepush/security-and-access/).

```bash
npx @codemagic/code-push-cli login "https://codepush.pro" --accessKey "$OTA_TOKEN"
npx @codemagic/code-push-cli release-react <app> android -d Production
```

Roll back with `code-push rollback <app> Production`. See the [CLI quick reference](https://docs.codemagic.io/rn-codepush/cli-quick-reference/).

## Bitrise CodePush

The Bitrise CodePush CLI reads a Bitrise API token from `BITRISE_API_TOKEN`. Prefer a **workspace API token** limited to Release Management and to the projects that need it, with an expiry date. See [workspace API tokens](https://docs.bitrise.io/en/bitrise-platform/workspaces/workspace-api-token.html).

```bash
export BITRISE_API_TOKEN="$OTA_TOKEN"
codepush push --bundle --platform android --deployment Production --app-version 1.0.0 --app-id <app id>
```

Roll back with `codepush rollback --deployment Production --app-id <app id>`. See the [Bitrise CodePush CLI](https://github.com/bitrise-io/bitrise-plugins-codepush-cli).

## Self-hosted code-push-server

Microsoft's `code-push-server` repository is archived. Its CLI, `code-push-standalone`, is built from that repository. Create a key with `code-push-standalone access-key add "mocco-ci" --ttl 30d`, then publish with it:

```bash
code-push-standalone login https://<your server> --accessKey "$OTA_TOKEN"
code-push-standalone release-react <app> android -d Production
```

Roll back with `code-push-standalone rollback <app> Production`. See the [CLI README](https://github.com/microsoft/code-push-server/blob/main/cli/README.md).

## Rotate

Keys from all four services expire or can be revoked. Create a new key, choose **Rotate** on the token's card in Mocco and paste it, then revoke the old key in the service. For services with a default expiry, rotate before the key expires, or the next publish fails.
