---
title: What Mocco offers
description: The Mocco products you can use today — deploy governance, OTA and force update, feature flags, notifications and messenger — plus API keys and SDKs, what each one does, and where its guides are.
type: guide
status: active
created: 2026-10-02
updated: 2026-10-04
confidence: high
owner: andrea
tags: [customer, getting-started, overview, guide]
related:
  - ./workspace-and-projects.md
  - ./members-and-access.md
  - ./api-keys.md
  - ./audit-log.md
  - ../../reference/roadmap.md
  - ../../reference/feature-map.md
---

# What Mocco offers

Mocco brings together the tools a team uses to ship and run an app: who may deploy, which app versions must update, which users see a feature, and what your users are telling you. Every product shares the same workspace, members, roles and audit log, so the approver roles you set up once work in every product.

Your team works in a **workspace**. Inside it, a **project** is one product you ship, with its apps and repositories. Deploy governance and notifications work across the workspace; OTA, feature flags, messenger and API keys work per project. [Set up a workspace and projects](./workspace-and-projects.md) is the place to start.

You turn products on and off on the workspace's **Products** page. Deploy governance is always on.

![The Products page: products grouped under Release and Support, deploy governance always on, the others with Turn on and Turn off, and the ones still to come listed under On the roadmap](./images/products.png)

## Deploy governance

Deploy governance makes "can push to GitHub" and "can deploy to production" two separate permissions. You describe a pipeline in a `.mocco.yml` file in your repository: steps that run in your CI, and gates between them. A gate pauses the run until enough people with the right roles approve it, and a step that needs a production credential gets it from Mocco only after its gate was approved. See [Deploy governance](../governance/overview.md).

## OTA and force update

For mobile apps. **Force update** sets the minimum and recommended version of each store app, so an old build is told to update. **Gated OTA publishing** keeps the OTA tool you use today (EAS Update, CodePush or hot-updater) and releases its publishing token only to an approved pipeline. **Hosted OTA updates** serve your React Native app's updates from Mocco, with percentage rollouts, protected channels and instant rollback. See [OTA and force update](../ota/overview.md).

## Feature flags

Flags with targeting rules, segments and percentage rollouts, evaluated through [OpenFeature](https://openfeature.dev). Each project has its own environments; a protected environment sends every change for approval, and a kill switch turns a flag off at once. See the [feature flags quickstart](../flags/quickstart.md).

## Notifications

Mocco posts events to Discord: its own events, such as a gate waiting for approval, and webhooks from Sentry, Vercel and GitHub. You decide which events go to which channel. See the [notifications overview](../notifications/overview.md).

## Messenger

In-app "contact us" for your users: signed in, or with an email they leave if they aren't. They write from inside your app, with screenshots if they like, and your team answers from the project's **Inbox**, with the user's app version and platform alongside each conversation. Replies reach the app as push notifications. See [In-app contact with Mocco Messenger](../messenger/contact-us.md).

## Help center

A public help site for your product. Write articles in Markdown with a live preview, or import an existing Mintlify site; publish them; and offer them in other languages, translated automatically when your Mocco has translation turned on and reviewed by your team. See [Publish a help center](../help/help-center.md).

## API keys and SDKs

Your apps, servers and CI talk to Mocco with a project's API keys: a **publishable** key for web and React Native apps, a **secret** key for servers and CI. The SDKs wrap that API for each platform: `@mocco/js` for browsers, `@mocco/node` for servers, `@mocco/react-native` for React Native apps, the OpenFeature providers for feature flags, and `@mocco/cli` for publishing OTA updates from CI. See [API keys](./api-keys.md).

## Coming later

The **Products** page also lists products that aren't available yet, marked **Coming soon**: a status page, app reviews, a feedback board, a forum, deep links and end-user identity. They can't be turned on until they ship.
