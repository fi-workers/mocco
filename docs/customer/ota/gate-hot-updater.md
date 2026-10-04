---
title: Gate hot-updater
description: Deploy hot-updater bundles only after a Mocco gate is approved, by keeping your storage provider's credentials in Mocco and writing them to .env.hotupdater in the publishing step.
type: guide
status: active
created: 2026-09-27
updated: 2026-10-04
confidence: medium
owner: andrea
tags: [customer, ota, hot-updater, guide]
related:
  - ./pipeline.md
---

# Gate hot-updater

hot-updater has no token of its own. `hot-updater deploy` writes bundles with the credentials of the storage and database you configured, such as Supabase, Cloudflare R2 and D1, AWS S3 with CloudFront, or Firebase. `hot-updater init` saves them to `.env.hotupdater`. Whoever holds those credentials can publish, so they are what Mocco keeps. Set up [Release a token to your pipeline](./pipeline.md) first.

## Store the credentials

Create credentials for CI that can do as little as your provider allows, separate from the ones you used for setup. hot-updater's own docs recommend this for AWS. For Supabase the deploy needs the service-role key, which is broad, so keep it only in Mocco.

Mocco stores one secret per token, so store the whole contents of `.env.hotupdater` as the token: every `KEY=value` line your deploy needs. For Cloudflare, for example:

```
HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=…
HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME=…
HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID=…
HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY=…
HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID=…
HOT_UPDATER_CLOUDFLARE_API_TOKEN=…
```

Add it in Mocco's **OTA tokens** page with the tool **hot-updater**, for example as `acme-production`. Its provider id is `ota-hot-updater`. The variable names for each provider are in hot-updater's [managed provider docs](https://github.com/gronxb/hot-updater/tree/main/docs/content/docs/managed).

## Deploy

The released value has several lines, so this fetch step writes it to `.env.hotupdater` and masks each value, in place of the single `OTA_TOKEN` line in the pipeline guide:

```yaml
      - name: Get the storage credentials from Mocco
        run: |
          body=$(jq -nc --arg run "$MOCCO_RUN_ID" --argjson step "$MOCCO_STEP" --arg token "$MOCCO_RUN_TOKEN" \
            '{runId: $run, stepIndex: $step, token: $token}')
          curl -fsS -X POST "${MOCCO_CALLBACK_URL%/callback}/credentials" \
            -H 'content-type: application/json' -d "$body" | jq -r '.credentials.value' > .env.hotupdater
          while IFS='=' read -r _ value; do
            if [ -n "$value" ]; then echo "::add-mask::$value"; fi
          done < .env.hotupdater

      - run: npm ci
      - run: npx hot-updater deploy -p android -c production -m "${{ github.event.client_payload.commitSha }}"
```

Leaving out `-p` deploys iOS and then Android. `-r 25` rolls out to a share of devices. See [deploying](https://github.com/gronxb/hot-updater/blob/main/docs/content/docs/guides/deploy.mdx).

## Roll back

Disable the bundle and devices go back to the previous one:

```bash
npx hot-updater bundle disable <bundle id> -y
```

`npx hot-updater bundle list -p android --json` lists bundle ids. Run it from your rollback pipeline with the same released credentials. See the [console guide](https://github.com/gronxb/hot-updater/blob/main/docs/content/docs/guides/console.mdx).

## Rotate

Rotate the keys in your provider, update the lines, choose **Rotate** on the token's card in Mocco and paste the new contents, then revoke the old keys in the provider.
