---
title: Feature flags quickstart
description: Create environments and a flag in Mocco, bind a server key to one environment, and evaluate flags locally from Node with the OpenFeature provider, or from flagd.
type: guide
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [customer, flags, openfeature, guide]
related:
  - ../../reference/flags.md
  - ../../reference/sdk.md
---

# Feature flags quickstart

Mocco's feature flags work with [OpenFeature](https://openfeature.dev), so your code calls the standard OpenFeature API and Mocco is the provider behind it. Your server downloads its environment's rules and evaluates every flag in memory: an evaluation never waits on the network, and the server keeps using the last rules it received if Mocco can't be reached.

## 1. Turn on feature flags

A workspace owner turns on **Feature flags** on the workspace's **Products** page. The project then shows a **Feature flags** tab.

## 2. Create environments and a flag

On the **Feature flags** tab, create an environment for each place your code runs, for example `staging` and `production`. An environment is just a separate set of rules: its name means nothing special to Mocco.

Then create a flag, for example `new-checkout`. A new flag is added to every environment switched **off**, so your code keeps using its own default until you switch the flag on. Each switch applies at once and is recorded in the environment's history, with who changed what.

![The Feature flags tab: two environments, the new-checkout flag switched on in Staging, and Staging's history](./images/flags-tab.png)

## 3. Create a server key for one environment

On the project's **API keys** tab, create a **Secret** key with the **flags:read** scope and choose the environment it reads. A key reads exactly one environment, so create one key per environment and give each server the key for its own environment. Copy the key from the notice; it is shown only once.

![Creating a secret key with flags:read: the form asks which environment the key reads](./images/flags-key.png)

Keep this key on the server. Mocco refuses secret keys sent from a browser, because the rules can hold user lists and other details your users shouldn't see.

## 4. Evaluate flags from Node

Install OpenFeature's server SDK and the Mocco provider:

```bash
npm install @openfeature/server-sdk @mocco/openfeature-server
```

Register the provider once when your server starts, then ask for flags anywhere:

```ts
import { MoccoProvider } from '@mocco/openfeature-server';
import { OpenFeature } from '@openfeature/server-sdk';

await OpenFeature.setProviderAndWait(new MoccoProvider({ secretKey: process.env.MOCCO_FLAGS_KEY! }));
const flags = OpenFeature.getClient();

if (await flags.getBooleanValue('new-checkout', false, { targetingKey: user.id })) {
  // the new checkout
}
```

The provider checks Mocco for new rules every 30 seconds (`pollIntervalMs` changes that). When nothing changed, Mocco answers with an empty `304 Not Modified`. When you switch a flag in the console, servers pick it up on their next check, and OpenFeature emits `PROVIDER_CONFIGURATION_CHANGED` with the flags that changed.

If Mocco can't be reached, the provider keeps answering from the last rules it received and reports `PROVIDER_STALE` until it reconnects. To start even when Mocco is unreachable at boot, pass a saved copy of the rules as `bootstrap`.

A flag that is switched off returns your code's default with the reason `DISABLED`. A flag key Mocco doesn't know returns your default with the error `FLAG_NOT_FOUND`, so a typo never breaks a request.

## Use flagd instead

Mocco serves standard flagd flag definitions, so a [flagd](https://flagd.dev) instance can sync from Mocco and serve flags to any OpenFeature flagd provider, in any language. Point flagd's HTTP sync at Mocco with the server key:

```bash
flagd start --sources='[{"uri":"https://api.mocco.club/v1/flags/ruleset","provider":"http","authHeader":"Bearer mk_sec_…","interval":30}]'
```

flagd sends the last `ETag` with each poll, so unchanged rules cost one small request.
