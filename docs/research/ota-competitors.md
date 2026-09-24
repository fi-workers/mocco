---
title: OTA release management — competitor research
description: Market scan of React Native / Capacitor / Flutter over-the-air update services and mobile release-management tools, to position Mocco's governed OTA product (issue #99).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, ota]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-ota-design.md
---

# OTA release management — competitor research

## Summary

Microsoft retired App Center, including CodePush, on 2025-03-31. It published a standalone `microsoft/code-push-server` (MIT) and then archived that repo on 2025-05-20, so there is no maintained upstream. The React Native OTA market split into three camps. **Expo EAS Update** is the default for Expo apps and speaks an open protocol. **CodePush-compatible hosts** (Revopush, Codemagic CodePush, Stallion, and others) sell migration from App Center. **Self-hosted open source** (hot-updater, xprem, self-hosted-expo-updates-server, Codemagic Patch) gives full control but leaves you to run the servers yourself. Everyone now ships channels, percentage rollouts, rollback and, increasingly, binary diffs (Expo made bsdiff default in SDK 56; Revopush 2.x, hot-updater and Stallion all diff). Prices have been pushed down to commodity levels: $25/month for 50K MAU (Revopush) and $1 per 2,500 installs (Codemagic, Shorebird). No competitor treats a production OTA push as a governed deploy. Approvals, separation of duties, an audit log that proves it was not tampered with, and CI upload without a long-lived token are either missing or locked in enterprise tiers. The mobile release-management tools that do have approvals (Runway, Bitrise Release Management) govern store submissions, not OTA. Mocco should implement the **Expo Updates protocol** so it inherits a maintained native client. It should compete on **governance, supply-chain integrity (signing in CI, OIDC upload), and correlation with what reached production**, and match OTA table stakes at a price in the same range as Revopush and EAS.

## Market map

| Segment | Players | Buyer |
|---|---|---|
| First-party framework cloud | Expo EAS Update (RN/Expo), Shorebird (Flutter), Ionic Appflow (Capacitor, sunsetting) | Teams already committed to the framework vendor |
| CodePush-compatible hosted successors | Revopush, Codemagic CodePush, Stallion (own SDK, CodePush-style), AppsOnAir / NextPush / BundleDrop (unverified, small) | App Center refugees who want minimal client changes |
| Self-hosted / open source OTA | hot-updater (gronxb), xprem (MIT open-core, Expo protocol), self-hosted-expo-updates-server, Codemagic Patch, archived code-push-server forks | Cost- or data-residency-sensitive teams with ops capacity |
| Capacitor live updates | Capgo (AGPL, self-hostable), Capawesome Cloud (Ionic's recommended Appflow successor) | Ionic/Capacitor teams |
| Mobile release management (store) | Runway, Bitrise Release Management, Codemagic (CI + publishing), fastlane (OSS tooling) | Mid-to-large mobile orgs with release trains |

Mocco sits across segments 2 and 5. It is an OTA server whose release objects obey the same gate, broker and audit rules as the rest of Mocco, and phase 2 extends those rules to store tracks.

## Competitor profiles

### 1. Expo EAS Update (deep)

- **What:** Hosted implementation of the Expo Updates protocol. Clients use the `expo-updates` native module, which also works in bare React Native ([docs](https://docs.expo.dev/bare/installing-updates/)).
- **Target:** Expo and React Native teams of any size. It is the de facto default for new RN apps.
- **Key features:**
  - Builds carry a **channel**, and a channel links to a **branch**. A branch is a list of updates and its latest is active; `eas channel:edit` relinks a channel ([how it works](https://docs.expo.dev/eas-update/how-it-works/)).
  - Updates only reach builds with an exactly matching **runtime version**.
  - **Per-update rollouts** use `--rollout-percentage`, edited with `eas update:edit` and reverted with `eas update:revert-update-rollout`; only one rollout per branch at a time. **Branch-based rollouts** use `eas channel:rollout`, one per channel ([rollouts](https://docs.expo.dev/eas-update/rollouts/)).
  - Republish, and the `rollBackToEmbedded` directive.
  - **Bundle diffing (bsdiff):** beta in SDK 55, default from SDK 56. Expo reports about 75% smaller downloads ([blog](https://expo.dev/blog/ship-smaller-ota-updates-bundle-diffing-comes-to-ota-updates-in-sdk-55)).
  - **End-to-end code signing** with `rsa-v1_5-sha256`, `keyid` "main". The certificate is embedded in the app config (`codeSigningCertificate`, `codeSigningMetadata`), and signing happens locally in `eas update`, so the private key never leaves the machine ([code signing](https://docs.expo.dev/eas-update/code-signing/)).
- **Pricing (2026)** ([expo.dev/pricing](https://expo.dev/pricing)):
  - Free: $0, 1,000 update MAU.
  - Starter: $19/month, 3,000 MAU, 100 GiB.
  - Production: $199/month, 50,000 MAU, 1 TiB.
  - Enterprise: custom, 1M+ MAU, 40 TiB.
  - Overage: graduated $0.005 down to $0.00085 per MAU, plus 40 MiB of bandwidth quota per extra MAU. Bandwidth overage is $0.10/GiB and storage $0.05/GiB.
  - Code signing requires **Production ($199/month) or Enterprise**.
- **Open source / self-host:** The client and the protocol spec are open ([spec](https://docs.expo.dev/technical-specs/expo-updates-1/)). The service is closed, but Expo ships a reference server ([custom-expo-updates-server](https://github.com/expo/custom-expo-updates-server)).
- **Strengths:** Best native client (emergency launch, fallback to embedded, filters, bsdiff). The spec is a public contract that other servers can implement. Deep integration with EAS Build and Workflows.
- **Weaknesses:**
  - Bandwidth is expensive at scale. The Codemagic blog estimates about $3,774/month at 1M MAU ([Codemagic](https://blog.codemagic.io/react-native-ota-tools-in-2026/)).
  - Signing is paywalled.
  - There is no approval or separation of duties on `eas update --channel production`: whoever has `EXPO_TOKEN` can ship to every phone.
  - Audit is limited. CI typically uses a long-lived `EXPO_TOKEN` robot token; an OIDC alternative was not verified (unverified).
- **Recent news:** SDK 55 (RN 0.83) introduced bsdiff and SDK 56 made it the default ([SDK 55](https://expo.dev/changelog/sdk-55), [CHANGELOG](https://github.com/expo/expo/blob/sdk-56/packages/expo-updates/CHANGELOG.md)).

### 2. App Center CodePush / microsoft/code-push-server (deep, as the displaced incumbent)

- **What:** App Center's OTA service. The client is `react-native-code-push`.
- **Status:** CodePush was retired with App Center on **2025-03-31**, which left only Analytics and Diagnostics ([retirement doc](https://github.com/MicrosoftDocs/appcenter-docs/blob/live/docs/retirement.md)). Microsoft released `microsoft/code-push-server` (MIT, "as is", no support) and **archived it on 2025-05-20** ([repo](https://github.com/microsoft/code-push-server)).
- **Features it defined:** Deployments (Staging/Production), `promote` between deployments, rollout %, mandatory flag, target binary version ranges (semver), rollback, and install metrics (download/install/failed per release).
- **Implication for Mocco:** The CodePush vocabulary ("promote", "mandatory", "target binary range") is what App Center refugees expect, so Mocco should use it in the UI even while speaking the Expo protocol on the wire. The community forks (e.g. `revopush/react-native-code-push`) are MIT clients that could later target a CodePush-compatible endpoint.

### 3. Revopush (deep)

- **What:** Hosted CodePush successor with an MIT fork of `react-native-code-push` and a CodePush-compatible CLI and API ([docs](https://docs.revopush.org/), [SDK](https://github.com/revopush/react-native-code-push)).
- **Target:** App Center migrants.
- **Features:** Migration with minimal code changes, and CI integrations for GitHub Actions, Bitrise and CircleCI. **Revopush 2.x** adds automatic byte-level diffs ([site](https://revopush.org/)).
- **Pricing** ([pricing](https://revopush.org/pricing)):
  - Starter: free, 1K MAU / 10 GB.
  - Startup: $25/month, 50K MAU / 100 GB.
  - Growing: $100, 300K / 1 TB.
  - Business: $250, 500K / 2 TB.
  - Professional: $500, 1M / 5 TB.
  - Enterprise: custom, with SSO and multi-cloud.
  - Overage: $0.03/GB and $1 per 1,000 MAU.
- **Open source / self-host:** SDK only. Server is closed.
- **Strengths:** Cheapest managed per-MAU pricing among the RN services here, and an easy CodePush migration.
- **Weaknesses:** Proprietary protocol lineage (CodePush). No public governance or approval features. Signing and audit are not advertised per tier (unverified).

### 4. hot-updater (gronxb, OSS) (deep)

- **What:** Self-hostable React Native OTA with a plugin architecture. Build plugins cover Metro, Re.Pack and Expo. Storage and DB plugins cover Supabase, Cloudflare R2 + D1, AWS S3 + Lambda@Edge, and Firebase ([repo](https://github.com/gronxb/hot-updater), [site](https://hot-updater.dev/)).
- **Target:** Teams that want infrastructure they own at near-zero license cost. The maintainer is part of the Korean RN community, which makes this the most relevant Korean-origin competitor (unverified).
- **Features:**
  - Web console, channels, force update, rollback, staged rollout, code signing, and New Architecture support.
  - **bsdiff patches** for Hermes bundles (a 10 MB archive becomes about 600 KB).
  - In September 2026 it moved to **"manifest artifacts" as its v1 OTA protocol** ([PR #1319](https://github.com/gronxb/hot-updater/pull/1319)) and added recovery of unfinished launches ([PR #1322](https://github.com/gronxb/hot-updater/pull/1322)).
- **Pricing:** Free (OSS). You pay your own cloud.
- **Metrics:** About 1.7k stars and 179 forks.
- **Strengths:** Edge-native update check (CDN or edge function), no vendor lock-in, very active.
- **Weaknesses:** Its own client, not the Expo protocol. Your team operates it. No RBAC or approval workflow and no tamper-evident audit.

### 5. Stallion (deep)

- **What:** Fully managed RN OTA with its own SDK (`react-native-stallion`, CodePush-style), a built-in testing framework, analytics and rollout control ([GitHub](https://github.com/stallion-tech/react-native-stallion)). Also sold on AWS Marketplace.
- **Pricing** ([pricing](https://stalliontech.io/pricing)):
  - Free: 10K MAU, 50 GB download. No overage allowed.
  - Pro: $51/month billed yearly (Codemagic lists $64), 100K MAU, 2 TB.
  - Enterprise: custom, 1M+ MAU, 30 TB.
  - Enterprise+ and On-Premise tiers also exist.
  - Patch (delta) updates and auto-rollback on Pro+. SSO on Enterprise+.
- **Strengths:** Biggest free tier among the RN services here. On-prem option. Crash-triggered auto-rollback.
- **Weaknesses:** Proprietary SDK and protocol, and approvals are not a first-class feature.

### 6. Codemagic CodePush / Codemagic Patch

- **What:** Codemagic (a CI/CD vendor) hosts a CodePush-compatible server with shared or dedicated infrastructure ([codemagic.io/codepush](https://codemagic.io/codepush/)). The self-hosted open-source "Codemagic Patch" adds pre-generated manifests, CDN delivery, binary diffs and fingerprinting ([blog](https://blog.codemagic.io/react-native-ota-tools-in-2026/)).
- **Pricing:**
  - Pay-as-you-go: $1 per 2,500 installs.
  - Fixed: from $990/month for 1M MAU, plus $99 per extra 100K MAU.
  - Unlimited transfer and storage.
- **Compliance:** SOC 2 Type 2.
- **Scale claims:** 1B+ update requests and 3 PB+ delivered per month.
- **Strengths:** Scale, compliance, and a bundle with CI.
- **Weaknesses:** CodePush lineage, and no gate or approval model.

### 7. Capgo (Capacitor)

- **What:** Live updates for Capacitor. **AGPL-3.0** across plugin, backend, console and CLI, and self-hostable on Supabase ([repo](https://github.com/Cap-go/capgo.app)).
- **Features:** Encrypted and signed bundles, channels, delta updates, auto-rollback, and device logs. Enterprise adds SSO, audit logs and SOC 2 ([enterprise](https://capgo.app/enterprise/)).
- **Pricing** ([pricing](https://capgo.app/pricing/)):
  - Solo: $14/month, 2K MAU / 100 GiB.
  - Maker: $39, 10K / 1,000 GiB.
  - Team: $99, 100K / 10,000 GiB.
  - Enterprise: $249+, 1M+.
  - Overage: $0.003 down to $0.0007 per MAU and $0.06 down to $0.01 per GiB. Annual billing is 20% off.
- **Relevance:** Closest in business model to Mocco (AGPL, open, and a paid cloud). It proves the model works for OTA. Not a direct RN competitor.

### 8. Ionic Appflow (status)

- Ionic announced the wind-down of its commercial products in February 2025, after the OutSystems acquisition, and stopped selling to new customers ([Ionic blog](https://ionic.io/blog/important-announcement-the-future-of-ionics-commercial-products)).
- **From 2026-10-01 there are no new apps or plan changes. End of life is 2027-12-31.**
- Ionic recommends **Capawesome Cloud** as the migration partner ([Capawesome](https://capawesome.io/docs/cloud/migrations/ionic-appflow/)).
- Takeaway: a second major OTA vendor exit in two years. "Will this vendor still exist?" is a real buyer concern, and AGPL plus self-host is an answer to it.

### 9. Shorebird (Flutter)

- **What:** Code push for Flutter via a modified engine and Dart binary patches, often under 1 MB ([docs](https://docs.shorebird.dev/code-push/)).
- **Pricing** ([pricing](https://shorebird.dev/pricing)):
  - Free: 5,000 patch installs, no overage.
  - Pro: $20/month, 50K installs. Adds signed patches, rollbacks, staging, and roles.
  - Business: $400/month, 1M installs.
  - Overage: $1 per 2,500 installs.
  - Enterprise adds SAML and audit logs.
- **Relevance:** Sets the "per install" pricing norm and shows that signing belongs in mid-tier plans. A Flutter client is out of scope for Mocco v1.

### 10. Runway (mobile release management)

- **What:** Release-train coordination for store releases. It integrates CI, stores, issue trackers and Slack, and runs checklists, release pilots, and rollouts and rollbacks of store phased releases ([runway.team](https://www.runway.team/)).
- **Pricing** ([pricing](https://www.runway.team/pricing)):
  - Basic: free, 2 apps and 4 read-write users.
  - Team: priced per app, unlimited users.
  - Enterprise: per app. Adds rollouts and rollbacks, API, SSO/SAML and RBAC.
  - Dollar amounts are not published.
- **No OTA or CodePush management.**
- **Relevance:** This is Mocco's phase 2 (native store releases). Runway coordinates but does not enforce credential-level "write is not deploy".

### 11. Bitrise Release Management

- **What:** A Bitrise add-on with approval workflows, role-based sign-off, automated Google Play staged rollouts, and Apple phased releases ([Bitrise](https://bitrise.io/platform/release-management), [docs](https://docs.bitrise.io/en/release-management/getting-started-with-release-management/release-management-concepts)).
- **Pricing:** A free tier covers unlimited apps; paid tiers are separate ([blog](https://bitrise.io/blog/post/introducing-new-offerings-in-release-management-paid-and-free)). Paid prices were not verified (unverified).
- **Relevance:** Approvals for store releases exist here, but only inside the Bitrise CI ecosystem.

### 12. fastlane

- **What:** OSS Ruby tooling. `deliver`/`pilot` handle App Store Connect and `supply` handles Google Play tracks, rollout fraction and metadata.
- **Governance:** Moved to the Mobile Native Foundation in 2023. Activity was low until new MNF leadership arrived in November 2025 ([history](https://connortumbleson.com/2025/12/01/a-history-of-fastlane/)).
- **Pricing:** Free.
- **Relevance:** Not a competitor but the lingua franca. Phase-2 store promotion should run fastlane or the store APIs inside a gated Mocco step, with store credentials issued by the broker.

### 13. Smaller self-hosted Expo-protocol servers

- **xprem:** Self-hosted, MIT open-core, implements the expo-updates and expo-observe protocols ([xprem.dev](https://www.xprem.dev/)).
- **self-hosted-expo-updates-server:** Supports bsdiff for SDK 55+ ([GitHub](https://github.com/umbertoghio/self-hosted-expo-updates-server)).
- Both show the Expo protocol is a viable target for third-party servers.

### Korean market note

No Korean-headquartered commercial OTA SaaS was found. Large Korean apps (e.g. fintech or super-apps) appear to run in-house CodePush-style servers (unverified). hot-updater is the notable Korean-community OSS option. A Korean-language console, KRW billing, and data residency in Korea (Seoul regions on AWS, GCP and Cloudflare) are low-cost differentiators for the home market.

## Feature matrix

| Capability | EAS Update | Revopush | Codemagic CP | Stallion | hot-updater | Capgo | Shorebird | Runway | Bitrise RM | **Mocco v1 (proposed)** |
|---|---|---|---|---|---|---|---|---|---|---|
| RN JS bundle OTA | Yes | Yes | Yes | Yes | Yes | No (Capacitor) | No (Flutter) | No | No | Yes |
| Open / standard protocol | Expo spec | CodePush | CodePush | Own | Own | Own | Own | n/a | n/a | Expo spec |
| Stock native client (no custom SDK) | expo-updates | fork | fork | own SDK | own SDK | plugin | engine | n/a | n/a | expo-updates |
| Channels + promote | Yes (branches) | Yes | Yes | Yes | Yes | Yes | staging | n/a | n/a | Yes |
| % rollout | Yes | Yes | Yes | Yes | Yes | Yes | No (unverified) | store only | store only | Yes (deterministic bucket) |
| Rollback / disable | Yes | Yes | Yes | Yes (auto) | Yes | Yes (auto) | Yes | store | store | Yes (instant, pre-signed) |
| Binary diff | Yes (SDK 56 default) | Yes (2.x) | Yes | Yes | Yes | Delta files | Yes | n/a | n/a | Later (v1.1) |
| Code signing | Production+ only | (unverified) | (unverified) | (unverified) | Yes | Yes | Pro+ | n/a | n/a | Yes, all tiers, key stays in CI |
| Approval gate to prod | No | No | No | No | No | No | No | checklists | Yes (store) | Yes (N-of-M, prevent_self, reason) |
| Tamper-evident audit | No | No | No | "patch logs" | No | Enterprise | Enterprise | (unverified) | (unverified) | Yes (hash chain) |
| CI upload w/o long-lived token (OIDC) | (unverified) | No (unverified) | No (unverified) | No (unverified) | own cloud creds | No (unverified) | No (unverified) | n/a | n/a | Yes |
| Adoption metrics | Yes | Yes | Yes | Yes | Basic | Yes | Business+ | store | store | Yes |
| Self-host | No | No | Patch (OSS) | On-prem tier | Yes | Yes (AGPL) | No | No | No | Yes (AGPL) |
| Store release mgmt | EAS Submit | No | CI publish | No | No | App Store publishing | No | Yes | Yes | Phase 2 (gated) |

## Pricing comparison

| Product | Free tier | Entry paid | Mid | ~1M MAU | Overage unit |
|---|---|---|---|---|---|
| EAS Update | 1K MAU | $19 / 3K MAU | $199 / 50K MAU | Enterprise custom (~$3.8K/mo estimate) | $0.005 to $0.00085/MAU; $0.10/GiB |
| Revopush | 1K MAU, 10 GB | $25 / 50K MAU | $100 / 300K, $250 / 500K | $500 / 1M, 5 TB | $1 per 1K MAU; $0.03/GB |
| Codemagic CodePush | none | $1 per 2,500 installs | n/a | from $990 / 1M MAU | $99 per 100K MAU |
| Stallion | 10K MAU, 50 GB | $51 / 100K MAU (yearly) | n/a | Enterprise custom | charged monthly |
| Capgo | trial | $14 / 2K MAU | $39 / 10K, $99 / 100K | $249+ / 1M | $0.003 to $0.0007/MAU; $0.06 to $0.01/GiB |
| Shorebird | 5K installs | $20 / 50K installs | n/a | $400 / 1M installs | $1 per 2,500 installs |
| hot-updater / xprem | free OSS | own cloud cost | n/a | own cloud cost | n/a |
| Runway | 2 apps, 4 users | per app (unpublished) | n/a | n/a | per app |
| Bitrise RM | free tier | add-on (unverified) | n/a | n/a | n/a |

Market anchor: a governed OTA tier that costs about what Revopush or EAS Starter cost for small teams (around $20–30/month for tens of thousands of MAU). Charge for governance (gates, audit export, OIDC trust policies, SSO) rather than for bandwidth. Self-host is free under AGPL.

## Gaps and opportunities for Mocco

1. **Nobody governs OTA.**
   - Every service lets any token holder push to 100% of production.
   - Mocco's existing `GateService` (N-of-M distinct principals, `prevent_self`, `reason_required`) and hash-chained `AuditService` are exactly what regulated, fintech and health RN apps need. Korean fintech teams face similar compliance pressure (unverified).
2. **Supply-chain integrity is paywalled or absent.**
   - EAS signing needs the $199 plan. The CodePush successors don't advertise signing.
   - Mocco can sign in CI (the key never reaches Mocco) and verify at upload.
   - Mocco can also **pre-sign rollback artifacts**, so an emergency rollback is instant and needs no key.
3. **Long-lived CI tokens.** `EXPO_TOKEN` and CodePush access keys are the norm. Mocco already has an OIDC and broker story, so it can ship "trusted publishing" for bundles, similar to PyPI and npm.
4. **Vendor-exit fatigue.** App Center (2025) and Appflow (2027) both exited. An AGPL server with a self-host story, on a standard protocol with a stock client, lowers switching risk in both directions.
5. **Correlation.** Mocco knows the git SHA, the run, and who approved. Release pages can link OTA releases to runs, flags (#101), incidents (#103) and store reviews (#94) with no integration work.
6. **Phase 2 white space.** Runway and Bitrise coordinate store releases but can't prevent a leaked Play service account key from promoting a track. Broker-issued, gate-bound store credentials can.

## Recommended positioning

"**The governed CodePush successor.** OTA updates on the open Expo Updates protocol, with production pushes that need an approval, a signature made in your CI, and an entry in a tamper-evident audit log. Hosted, or self-host under AGPL."

### Table stakes (v1 must have)
- Apps per project with iOS and Android platforms. Runtime-version targeting, with fingerprint or app-version policies computed client-side by the Expo tooling.
- Upload from CI (bundle, assets, source maps, metadata including git SHA, run id and message), with content-addressed immutable asset storage behind a CDN.
- Channels (`staging`, `production`, custom). Promote an existing release between channels without re-upload.
- Percentage rollout (deterministic by `EAS-Client-ID` hash) with pause, resume, increase, and complete.
- Instant rollback to the previous release, disable a release, and roll back to embedded.
- Code signing compatible with `expo-updates` (`rsa-v1_5-sha256` with an embedded certificate).
- Adoption metrics: active devices per release, derived from update-check traffic.
- CLI plus a GitHub Action, and a console UI.

### Differentiators
- **Gated promotion.** Promoting to a protected channel, raising its rollout, or un-disabling a release there is an approval request under N-of-M role rules, `prevent_self`, and `reason_required`. It reuses `evaluateGate`.
- **OIDC trusted publishing.** GitHub Actions uploads with a workflow identity token matched against a trust policy (repo, ref, workflow). Mocco-dispatched runs instead get a broker-issued, gate-bound upload credential.
- **Key-in-CI signing with pre-signed rollback.** Mocco stores only the certificate. It verifies every uploaded signature and serves the stored signed bytes. At upload, CI also signs the rollback manifests and directives, so rollbacks never need the key.
- **Hash-chained audit** of every upload, promotion, rollout change and rollback, with the approvers recorded.
- **Run correlation.** Every release links to a Mocco run and commit, and later to flags, incidents and reviews.
- **Self-host parity.** Node 22 plus Postgres plus any S3-compatible store.

### Deliberately skip (v1)
- A custom native updater SDK. Use `expo-updates`, plus a thin JS helper package for events.
- CodePush wire compatibility (`react-native-code-push` clients). Reconsider as a migration shim in v2 if demand shows up.
- Server-generated bsdiff patches (v1.1: the SDK 56 client supports it, and it is a pure server addition).
- Automatic crash-rate rollback (needs crash telemetry).
- Flutter/Shorebird-style engine patching and Capacitor clients.
- Native store release management (phase 2), A/B experiments on OTA, and per-user targeting beyond channels (use #101 flags).

## Sources

- https://docs.expo.dev/technical-specs/expo-updates-1/
- https://expo.dev/pricing
- https://docs.expo.dev/eas-update/code-signing/
- https://docs.expo.dev/eas-update/rollouts/
- https://docs.expo.dev/eas-update/how-it-works/
- https://docs.expo.dev/bare/installing-updates/
- https://expo.dev/blog/ship-smaller-ota-updates-bundle-diffing-comes-to-ota-updates-in-sdk-55
- https://expo.dev/changelog/sdk-55
- https://github.com/expo/expo/blob/sdk-56/packages/expo-updates/CHANGELOG.md
- https://github.com/expo/expo (expo-updates `FileDownloader.kt`: `EAS-Client-ID`, `Expo-Current-Update-ID`, `Expo-Embedded-Update-ID`, `A-IM: bsdiff`, `expo-base-update-id`; `LoaderSelectionPolicyFilterAware.kt`: commitTime ordering)
- https://github.com/expo/custom-expo-updates-server (`pages/api/manifest.ts`: per-part `expo-signature` over the manifest/directive string)
- https://github.com/MicrosoftDocs/appcenter-docs/blob/live/docs/retirement.md
- https://github.com/microsoft/code-push-server
- https://revopush.org/pricing
- https://revopush.org/
- https://docs.revopush.org/
- https://github.com/revopush/react-native-code-push
- https://github.com/gronxb/hot-updater
- https://github.com/gronxb/hot-updater/pull/1319
- https://github.com/gronxb/hot-updater/pull/1322
- https://hot-updater.dev/
- https://stalliontech.io/pricing
- https://github.com/stallion-tech/react-native-stallion
- https://codemagic.io/codepush/
- https://blog.codemagic.io/react-native-ota-tools-in-2026/
- https://docs.codemagic.io/billing/pricing/
- https://capgo.app/pricing/
- https://capgo.app/enterprise/
- https://github.com/Cap-go/capgo.app
- https://ionic.io/blog/important-announcement-the-future-of-ionics-commercial-products
- https://capawesome.io/docs/cloud/migrations/ionic-appflow/
- https://shorebird.dev/pricing
- https://docs.shorebird.dev/code-push/
- https://www.runway.team/pricing
- https://bitrise.io/platform/release-management
- https://bitrise.io/blog/post/introducing-new-offerings-in-release-management-paid-and-free
- https://connortumbleson.com/2025/12/01/a-history-of-fastlane/
- https://www.xprem.dev/
- https://github.com/umbertoghio/self-hosted-expo-updates-server
