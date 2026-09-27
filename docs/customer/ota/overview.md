---
title: OTA and force update overview
description: What Mocco's OTA product does today — force update for store apps, and approval-gated publishing with the OTA tool you already use — and the order to set it up in.
type: guide
status: active
created: 2026-09-27
updated: 2026-09-27
confidence: high
owner: andrea
tags: [customer, ota, force-update, guide]
related:
  - ./force-update.md
  - ./pipeline.md
---

# OTA and force update

Mocco puts the changes that reach your users' phones behind the same approvals as a production deploy. Two parts are available today, and each works on its own.

**Force update** tells an app on an old store build to update. You set a minimum supported version (older builds must update), a recommended version (older builds see a prompt they can dismiss) and versions to block outright. The app asks Mocco on launch. Raising a version waits for approval when you require it; lowering one applies at once and is reviewed afterwards, so nobody waits for an approver during an incident. See [Force update](./force-update.md).

**Gated OTA publishing** keeps your current OTA tool (EAS Update, a hosted CodePush service or hot-updater). Mocco holds the tool's publishing token and hands it only to a pipeline step that passed an approved gate, so an update can't go out without the approval, and every release is in the audit log. Nothing changes in your app. See [Release a token to your pipeline](./pipeline.md) and the guide for your tool.

## Before you start

- Turn on **OTA and force update** under **Products** in your workspace.
- Create a project and add your iOS and Android apps on the project's **Overview** tab. Force update works per store app.
- Create the roles your approvers hold under **Access** (for example `mobile-release`) and add their members. Only workspace owners and admins can change roles.

## Setup order

1. [Force update](./force-update.md): set a policy for each store app and call the version check from your app.
2. [Release a token to your pipeline](./pipeline.md): store your OTA tool's token and allow one pipeline gate to receive it.
3. The guide for your tool: [EAS Update](./gate-eas-update.md), [CodePush](./gate-codepush.md) or [hot-updater](./gate-hot-updater.md).
