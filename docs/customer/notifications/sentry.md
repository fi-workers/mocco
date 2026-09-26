---
title: Connect Sentry
description: How to send new Sentry issues to Mocco with a Sentry internal integration, which secret to paste, the events and filter keys you get, and how to check it works.
type: guide
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [customer, notifications, sentry, webhooks, guide]
related:
  - ./overview.md
  - ./troubleshooting.md
---

# Connect Sentry

Mocco receives Sentry issue webhooks through an **internal integration** in your Sentry
organization. Each time Sentry creates a new issue, Mocco can post it to Discord.

You need to be an owner or admin in Mocco, and able to manage integrations in Sentry.

## 1. Start the source in Mocco

1. Open **Notifications**, then the **Sources** tab.
2. Click **Add source** and choose **Sentry** as the **Kind**.
3. Give it a **Name**, such as `Sentry (acme)`.

Keep this form open. The **Signing secret** comes from Sentry in the next step.

## 2. Create an internal integration in Sentry

1. In Sentry, go to **Settings > Developer Settings** for your organization.
2. Create a new **internal integration**.
3. Give it a name, such as `Mocco`.
4. Set the webhook URL to Mocco's ingest URL for this source. If you have not created the source
   yet, create it with a placeholder secret first, copy its **Ingest URL** from the list, and use
   **Rotate secret** later to paste the real one.
5. Give the integration read access to issues and events, then, in its webhook subscriptions,
   turn on **issue**. Sentry lets you subscribe only to resources the integration's permissions
   cover.
6. Save the integration. Sentry shows its **Client Secret** on the integration's page.

You do not need to turn on the integration's alert action or create an alert rule: Mocco listens
to the issue webhook, which Sentry sends for every new issue. Alert webhooks are recorded as
`ignored`.

## 3. Finish in Mocco

1. Paste Sentry's **Client Secret** into **Signing secret**.
2. Click **Create source**.
3. Copy the **Ingest URL** of the new source (click **Copy**) and make sure it is the webhook URL
   of the Sentry integration.

Sentry signs every webhook with the Client Secret (the `Sentry-Hook-Signature` header). Mocco
checks it on every delivery and refuses anything that does not match.

If you ever reset the Client Secret in Sentry, click **Rotate secret** on the source in Mocco and
paste the new one. The ingest URL stays the same.

## What you get

| Sentry webhook | Mocco event |
|---|---|
| issue, action `created` | `sentry.issue.created` |
| issue, any other action (`resolved`, `assigned`, `archived`, `unresolved`) | recorded as `ignored` |
| any other resource | recorded as `ignored` |

Filter keys for rules on `sentry.issue.created`:

| Key | Example | Notes |
|---|---|---|
| `project` | `web` | The Sentry project slug, when Sentry sends it. |
| `environment` | `production` | `unknown` when the issue has no environment. |
| `level` | `error` | Lowercase: `fatal`, `error`, `warning`, `info` or `debug`. |

For example, a rule on `sentry.issue.created` with the filter `environment=production` posts only
production issues. The **Sentry** preset adds `sentry.issue.created` without a filter.

## Check that it works

Trigger a new issue in Sentry (for example an error from a test project). Within a few seconds it
appears in Mocco's **Activity** tab with outcome `published`, and in the channels whose rules match.
If nothing appears at all, see [Troubleshooting](./troubleshooting.md#nothing-shows-up-in-activity).

Sentry expects an answer within one second. Mocco answers right away and posts to Discord
afterwards, so a slow Discord never makes Sentry time out.
