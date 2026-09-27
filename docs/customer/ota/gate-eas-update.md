---
title: Gate EAS Update
description: Publish EAS Updates only after a Mocco gate is approved — create a robot token in Expo, store it in Mocco, and run eas update with the released EXPO_TOKEN.
type: guide
status: active
created: 2026-09-27
updated: 2026-09-27
confidence: medium
owner: andrea
tags: [customer, ota, eas, expo, guide]
related:
  - ./pipeline.md
---

# Gate EAS Update

EAS CLI publishes with an Expo access token in the `EXPO_TOKEN` environment variable. Mocco holds that token and releases it to your publishing step after the gate. Set up [Release a token to your pipeline](./pipeline.md) first; this page covers the Expo side.

## Create the token

Use a **robot user** rather than a person's token. A personal access token acts as that person across every Expo account they can reach, while a robot user belongs to one account, can't sign in, and gets only the role you give it. Give it the **Developer** role, which can publish updates. Then create an access token for it on the account's access token settings. See Expo's [programmatic access](https://docs.expo.dev/accounts/programmatic-access/) and [roles](https://docs.expo.dev/accounts/account-types/#manage-access) pages.

Expo doesn't let you limit a token to one project or one channel. On the Enterprise plan, *protected channels* limit publishing to production to the Release Manager role; without them the Release Manager role has the same access as Developer.

Store the token in Mocco's **OTA tokens** tab with the tool **EAS Update**, for example as `acme-production`. Its provider id is `ota-eas`.

## Publish

In the publishing job from the pipeline guide, export the released token as `EXPO_TOKEN` and run `eas update` without prompts. The project must already be linked to EAS (`extra.eas.projectId` in your app config):

```yaml
      - name: Get the publishing token from Mocco
        run: |
          # … as in the pipeline guide …
          echo "EXPO_TOKEN=$secret" >> "$GITHUB_ENV"

      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eas-cli@latest update --channel production --environment production --message "${{ github.event.client_payload.commitSha }}" --non-interactive
```

`--environment` is required from Expo SDK 55. `--rollout-percentage 10` publishes to a share of devices first, and `-p ios` or `-p android` limits the platform. See the [EAS CLI reference](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/README.md).

## Roll back

Run the rollback in your second pipeline (the one whose gate the on-call engineer approves alone), with the same released token:

```bash
npx eas-cli@latest update:rollback <update group id> --message "Roll back" --non-interactive
```

It republishes the update group before the one you name, or goes back to the build's embedded bundle when there is none. `eas update:roll-back-to-embedded --channel production --runtime-version <version> --non-interactive` goes straight to the embedded bundle.

## Rotate

Create a new access token for the robot user, choose **Rotate** on the token's card in Mocco and paste it, then delete the old token in Expo. The fingerprint on the card changes.
