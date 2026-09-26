---
title: Connect Vercel
description: How to send Vercel deployment events to Mocco with a team webhook (Pro and Enterprise plans), which secret to paste, the events and filter keys you get, and how to check it works.
type: guide
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [customer, notifications, vercel, webhooks, guide]
related:
  - ./overview.md
  - ./troubleshooting.md
---

# Connect Vercel

Mocco receives Vercel deployment events through a **team webhook**. Mocco can then post
successful production deploys, failed deploys and cancelled deploys to Discord.

> **Plan requirement.** Vercel offers team (account) webhooks on the **Pro** and **Enterprise**
> plans only. On the Hobby plan there is no webhook to point at Mocco.

You need to be an owner or admin in Mocco, and have permission to manage webhooks for the Vercel
team.

## 1. Create the webhook in Vercel

Vercel shows the webhook's secret only once, right after you create it, so create the webhook
first and keep the secret at hand.

1. In Mocco, open **Notifications > Sources**, click **Add source**, choose **Vercel** as the
   **Kind**, and give it a **Name**. Keep the form open.
2. In the Vercel dashboard, choose your team, then go to **Settings > Webhooks**.
3. Select the deployment events:
   - **Deployment Created**
   - **Deployment Succeeded**
   - **Deployment Error**
   - **Deployment Cancelled**
4. Choose the projects the webhook covers (all team projects, or the ones you want).
5. Enter the endpoint URL: Mocco's ingest URL for this source (see the note below).
6. Click **Create Webhook**. The **Webhook Created** dialog shows the secret. Copy it now; Vercel
   will not show it again.

**The ingest URL.** Mocco creates the ingest URL together with the source, and the source needs the
secret. If you want the URL first, create the source with a placeholder secret, copy its
**Ingest URL**, create the webhook in Vercel, then click **Rotate secret** on the source and paste
the real secret. The ingest URL does not change when you rotate.

## 2. Finish in Mocco

1. Paste the Vercel secret into **Signing secret**.
2. Click **Create source** (or **Rotate secret** if you used a placeholder).

Vercel signs every delivery with that secret (the `x-vercel-signature` header). Mocco checks it on
every delivery and refuses anything that does not match. If you lose the secret, create a new
webhook in Vercel and rotate the secret in Mocco.

## What you get

| Vercel event | Mocco event |
|---|---|
| `deployment.created` | `vercel.deployment.created` |
| `deployment.succeeded` | `vercel.deployment.succeeded` |
| `deployment.error` | `vercel.deployment.error` |
| `deployment.canceled` | `vercel.deployment.canceled` |
| anything else (project, domain, firewall events…) | recorded as `ignored` |

Filter keys:

| Key | Example | Notes |
|---|---|---|
| `project` | `web` | The Vercel project name. |
| `target` | `production` | `production`, a custom environment name, or `preview` (Vercel sends no target for preview deployments; Mocco records `preview`). |
| `branch` | `main` | The Git branch, when the deployment came from Git. |

The **Vercel** preset adds `vercel.deployment.succeeded` with the filter `target=production` (so
preview deploys stay quiet), plus `vercel.deployment.error` and `vercel.deployment.canceled` for
every target. Selecting **Deployment Created** in Vercel is optional; no preset uses it, but you
can add a rule for `vercel.deployment.created` yourself.

## Check that it works

Deploy a project the webhook covers. The deployment appears in Mocco's **Activity** tab. A preview
deploy that no channel asked for shows why, for example
``rule `vercel.deployment.succeeded` needs target = "production" (the event has "preview")``.
See [Troubleshooting](./troubleshooting.md) if nothing arrives.
