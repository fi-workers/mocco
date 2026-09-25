---
title: CodePush successor market — demand, migrations, pricing, compliance
description: Follow-up to the OTA competitor research. Quantifies post-App Center demand, collects migration case studies (English and Korean), normalizes 2026 pricing per MAU, gathers complaints and regulatory evidence, and proposes a go-to-market for Mocco's governed OTA.
type: research
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: medium
owner: andrea
tags: [research, ota, codepush, market, pricing, compliance]
related:
  - ./ota-competitors.md
  - ./codepush-technical.md
  - ../specs/2026-09-25-ota-release-control-design.md
  - ../reference/roadmap.md
---

# CodePush successor market (2026-09)

This note adds to `docs/research/ota-competitors.md` and does not repeat its profiles. It covers what that doc left open: how much demand exists, where App Center users went, what the new entrants charge, what customers complain about, and whether regulated teams need governance.

## 0. What changed since ota-competitors.md

- **Bitrise CodePush launched on 2026-03-10** ([blog](https://bitrise.io/blog/post/ship-react-native-updates-in-minutes-codepush-on-bitrise-is-now-live)). It is free up to **100K MAU** and costs $294/mo at 250K and $1,111/mo at 1M ([docs](https://docs.bitrise.io/en/release-management/codepush/about-codepush)). Its product page claims an "audit trail & role-based access", code signing, delta updates, SOC 2 Type II and PCI DSS ([page](https://bitrise.io/platform/codepush)). The SDK is a fork of `@code-push-next/react-native-code-push` ([React Native Rewind](https://thereactnativerewind.com/guides/skipping-the-app-store-review-queue-with-bitrise-codepush)). **This is now the price floor for hosted CodePush.** It also pairs OTA with Bitrise Release Management, which already has store approvals.
- **`@code-push-next/react-native-code-push` is Codemagic's SDK.** Its npm repository field points to `codemagic-ci-cd/react-native-code-push`, and the listed npm maintainers are `choiminseok` and `kimminsik` (registry metadata). It has become the de facto shared CodePush client, since Bitrise builds on it too. The README now steers new projects to **Codemagic Patch**, which Codemagic open-sourced on 2026-06-30 under an FSL-1.1 → Apache-2.0 license, with 126 stars ([repo](https://github.com/codemagic-ci-cd/codemagic-patch)). Patch has a `release.deploy` role, an `auditRepository.ts`, and an explicit "approve fingerprint mismatch" step. No N-of-M approval was found (unverified).
- **Other entrants since 2025:**
  - **Appcircle CodePush** (Show HN 2025-07-28, [HN](https://news.ycombinator.com/item?id=44712460)) claims "detailed audit trails, role-based access control", SSO, self-hosting and code signing ([page](https://appcircle.io/codepush)). Pricing is not published.
  - **AppZung** is a French team with EU hosting and signed updates. It has no free plan and no published tiers ([FAQ](https://appzung.com/faq/)).
  - **Pushy** (`react-native-update`, China) costs ¥0–7,200 per year, with CDN included ([pricing](https://pushy.react-native.cn/pricing.html)).
  - **Smaller or new entrants:** BetterCodePush, AppSpacer, rnpush.com, BundleDrop, NextPush and Corenna. All are small and unverified; they appear mainly through SEO articles ([AppSpacer list](https://docs.appspacer.com/blog/7-best-codepush-alternatives), [akshatsethi](https://akshatsethi.com/posts/codepush-alternatives-in-2026/)).
- **Stallion has moved upmarket.** It now has SOC 2 **Type I** (Type II in progress) ([trust](https://stalliontech.io/trust)). Its Enterprise tier markets audit logging, RBAC, SAML/OIDC SSO, on-prem and data residency to "financial services, healthcare, and government" ([enterprise](https://stalliontech.io/enterprise)).
- **Expo audit logs exist but are Enterprise-only.** They are immutable, kept for 18 months, and cover "EAS Update Branch/Channel" entities. The docs do not say whether individual publishes and rollouts are logged ([docs](https://docs.expo.dev/accounts/audit-logs/), [changelog](https://expo.dev/changelog/2024-08-21-audit-logs-available)). CI still authenticates with `EXPO_TOKEN`: robot users can have roles, but no OIDC or workload-identity federation is documented ([programmatic access](https://docs.expo.dev/accounts/programmatic-access/)). This confirms the "(unverified)" OIDC gap in the earlier doc.

**Net effect on positioning.** "Nobody has RBAC or audit" is no longer true. Bitrise, Appcircle, Stallion Enterprise and Expo Enterprise all claim some version of it. What still appears nowhere is a **pre-deploy approval gate for OTA** (N-of-M approvers, no self-approval, a required reason), **tamper-evident** audit that customers can verify themselves rather than a vendor's "immutable" claim, **OIDC trusted publishing**, and all of that **in a self-hostable or cheap tier**.

## 1. Demand signals

### 1.1 Installed base before the shutdown

- `react-native-code-push` averaged **~560K downloads/month in 2023 and ~597K/month in 2024**, peaking at **682K in 2024-04** (npm API, `api.npmjs.org/downloads/range`).
- `microsoft/react-native-code-push` has **9,120 stars** and **9,339 public dependent repositories** on GitHub. It was archived on 2025-05-20 (GitHub API, `/network/dependents`). For comparison: hot-updater has 48 dependents, Revopush 14, Codemagic's fork 10, Stallion 8, and Soomgo's fork 4. Most production apps are in private repos, so these counts only show direction.
- Microsoft announced the retirement on **2024-03-14** ([appisto timeline](https://appisto.app/blog/app-center-retirement-migration-guide), [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2024/03/18/app-center-retirement.aspx)). No Microsoft statement giving CodePush app or user counts was found (unverified).
- Codemagic says it serves "1B+ API calls per month", "300M+ monthly active users" and 3 PB/month ([pricing](https://codemagic.io/pricing/), [SystemsDigest](https://systemsdigest.com/videos/numbers-behind-codemagic-codepush)).
- Revopush is described as serving "1,000+ customers" and 300 TB/month. That comes from a third-party directory, not Revopush itself (unverified; [saasbrowser](https://saasbrowser.com/en/saas/645960/revopush)).

### 1.2 Monthly npm downloads

Pulled on 2026-09-25 from the npm API, as monthly totals.

| package | 2024-01 | 2024-06 | 2024-12 | 2025-03 | 2025-06 | 2025-09 | 2025-12 | 2026-03 | 2026-06 | 2026-08 |
|---|---|---|---|---|---|---|---|---|---|---|
| `react-native` (baseline) | 8.06M | 8.89M | 10.3M | 12.9M | 14.2M | 16.9M | 17.1M | 28.7M | 41.5M | 51.8M |
| `react-native-code-push` | 608K | 583K | 433K | 434K | 289K | 279K | 205K | 264K | 237K | 117K |
| `expo-updates` | 686K | 806K | 1.06M | 1.53M | 1.93M | 2.41M | 2.63M | 5.22M | 10.8M | 13.9M |
| `@code-push-next/react-native-code-push` (Codemagic, Bitrise) | 0 | 0 | 0 | 969 | 4,951 | 18,274 | 22,704 | 57,641 | 83,591 | 228,362 |
| `@hot-updater/react-native` | 28 | 50 | 172 | 8,243 | 12,062 | 23,921 | 27,028 | 63,588 | 88,309 | 149,097 |
| `@revopush/react-native-code-push` | 0 | 0 | 0 | 909 | 16,408 | 19,078 | 19,545 | 31,927 | 47,124 | 48,386 |
| `react-native-stallion` | 111 | 6 | 58 | 344 | 1,077 | 4,340 | 5,276 | 9,628 | 27,058 | 40,435 |
| `react-native-ota-hot-update` | 0 | 0 | 786 | 3,948 | 8,730 | 8,783 | 9,391 | 10,810 | 13,994 | 19,518 |
| `@bravemobile/react-native-code-push` (Soomgo) | 0 | 4,562 | 684 | 2,025 | 3,836 | 6,887 | 8,659 | 16,190 | 14,865 | 18,684 |
| `appcenter-cli` | 295K | 320K | 246K | 215K | 119K | 94K | 54K | 83K | 104K | 270K |

Other 2026-08 figures: `react-native-update` (Pushy) 13,054; `@appzung/react-native-code-push` 4,133; `@codemagic/react-native-patch` 905 (new); `@capgo/capacitor-updater` 1.19M. The last week (2026-09-15 to 21) for comparison: `expo-updates` 2.70M, `@code-push-next` 35.8K, `@hot-updater/react-native` 25.6K, `react-native-code-push` 24.3K, Revopush 8.2K, Stallion 5.0K.

**Caveat.** Registry-wide downloads inflated in 2026. `react-native` itself grew 3.6× between 2025-12 and 2026-08, and several dead or low-use packages jumped in 2026-08 (`appcenter-cli` went from 104K to 270K). CI, mirrors and AI coding agents are the likely cause (unverified). So the analysis below reads **share of `react-native` downloads** and relative rank, not absolute counts.

| Share of `react-native` downloads | 2024-01 | 2025-03 | 2025-12 | 2026-08 |
|---|---|---|---|---|
| `react-native-code-push` | 7.55% | 3.35% | 1.20% | 0.23% |
| `expo-updates` | 8.51% | 11.8% | 15.4% | 26.8% |
| CodePush-lineage forks combined (`@code-push-next`, `@revopush`, `@bravemobile`, `@appzung`) | ~0% | 0.04% | 0.32% | 0.58% |
| `@hot-updater/react-native` | 0% | 0.06% | 0.16% | 0.29% |
| `react-native-stallion` | 0% | 0% | 0.03% | 0.08% |

### 1.3 Migration flows

1. **Expo won the default.** Its share of downloads tripled. Part of that is new apps created with Expo rather than migrations (Expo's templates and fingerprint tooling ship widely; `@expo/fingerprint` had 6.5M weekly downloads). Expo's own "replace App Center" guide positions EAS Update as "the most comparable alternative" ([Expo blog](https://expo.dev/blog/how-to-replace-app-center-and-codepush)).
2. **The CodePush wire protocol survived.** The legacy package plus the forks still totalled **~412K downloads in 2026-08**, against ~588K in 2024-06. The forks alone grew from zero to about 300K/month. `react-native-code-push` itself still sees 117K/month, which implies many apps still ship the stock archived client pointed at self-hosted servers. The package's own README says it "won't support new Architecture … opt out from new architecture" on RN 0.76+ ([npm search snippet](https://www.npmjs.com/package/react-native-code-push)), so that base is stuck or will have to migrate.
3. **Hosted CodePush-compatible services are consolidating around one SDK.** `@code-push-next` (Codemagic, and Bitrise from 2026-03) overtook Revopush in 2025-12 and is now about 4.7× larger. Its growth steepened after Bitrise's launch.
4. **Self-hosted OSS is the fastest-growing non-Expo path.** hot-updater now downloads roughly 3× more than Revopush and ~3.7× more than Stallion.
5. **Proprietary SDKs grow but stay small.** Stallion grew 7.7× over 2026, from a small base.

**Rough migration estimate (unverified model).** The two ways of measuring disagree, and the truth probably lies between them.

- **By share of `react-native` downloads.** Take the 2024-06 CodePush base (6.6% of RN) as 100. By 2026-08 the stock client holds about 3.5, CodePush forks about 9 (Codemagic/Bitrise ≈ 6.7, Revopush ≈ 1.4, Soomgo/AppZung ≈ 0.8), hot-updater about 4.4, and Stallion/Pushy/other about 2. That leaves about 80% unaccounted for. Some of it went to `expo-updates` and some left OTA, but most of the gap comes from inflation in RN's own download count.
- **By absolute downloads,** against 588K in 2024-06: stock client 117K (20%), forks about 300K (51%), hot-updater 149K (25%), others about 73K (12%). That sums to more than 100% because of 2026 inflation.

Either way the ranking is stable: **CodePush-protocol forks > hot-updater > stock client > Stallion/Pushy/other**. Expo absorbs most new apps. These figures are download ratios, not app counts.

**Implication for Mocco.** The earlier doc deferred CodePush wire compatibility to v2. The data argues for moving it up. The CodePush-protocol population is still at least 1.5× the combined size of every non-Expo alternative, and every hosted competitor except Expo and Stallion speaks it.

## 2. Migration case studies

| Org (source) | From → To | Why | Notes |
|---|---|---|---|
| **Soomgo**, Korea, 2025-05-07 ([blog](https://soomgo.team/blog/posts/67846d14271b0f4d3124ffb4)) | App Center CodePush → **in-house** (S3 + CloudFront + GitHub Actions) plus their own fork `@bravemobile/react-native-code-push` | The update check took 1.5 s p90 from Korea and the shutdown was coming. They judged EAS migration "more complex than necessary". | Update check fell from 1.5 s to 0.3 s and bundle download from 15 s to 3 s (p90). Deploy status changes go through **GitHub Actions so developers hold no AWS keys**, a home-made governance control. About 30 deploys/month. New Architecture support was still pending at the time of writing. The fork is now at v13 and ships weekly. |
| **Toss**, Korea ([toss.tech 2024](https://toss.tech/article/react-native-2024), [Granite](https://github.com/toss/granite)) | Never on App Center for its main app (unverified). Runs an **in-house** per-service bundle platform, open-sourced as **Granite** (2025-05, 476★): Pulumi `ReactNativeBundleCDN` on AWS and `granite-forge deploy` to S3/CDN | A microservice RN architecture with shared and service bundles loaded dynamically. Bundle size (200 KB targets). | Apps-in-Toss partners upload bundles through the console or CI ([notice](https://techchat-apps-in-toss.toss.im/t/ci-cd/1632)). hot-updater's creator, Sungyu Kang (gronxb), lists `@toss` on GitHub and presented hot-updater at FECONF25 as a member of the Toss RN Framework team ([review](https://developer-dreamer.tistory.com/183)). hot-updater won the **2025 Open Source Developer Contest grand prize** ([oss.kr](https://www.oss.kr/opensource/hub/56946)). |
| Unnamed Korean team, 2025-03-10 ([dragon-developer](https://dragon-developer.tistory.com/81)) | CodePush → **EAS Update** | No New Architecture support on RN 0.76+. Rejected self-hosted code-push-server (~$120/mo on Azure plus maintenance) and hot-updater ("not stable/documented enough" at the time). | Accepted a cost of about $1,124/mo for an SLA and runtimeVersion targeting. Pain points: Android release bundle mismatches, and brownfield Expo integration is hard. |
| Unnamed Korean company, FECONF25 attendee, 2025-09 ([blog](https://developer-dreamer.tistory.com/183)) | CodePush → **hot-updater** → dropped it | Storage-bucket costs rose because full bundles were uploaded each time (this predates hot-updater's bsdiff). | The next choice was not stated. |
| Korean solo/SMB, 2025-04-25 ([izizi](https://izizi.tistory.com/63)) | CodePush → **code-push-server standalone** on Azure Korea Central | "Risk minimization": no refactor right before a user-acquisition push. | Struggled with GitHub OAuth for org accounts and undocumented deploy steps. Similar posts: [rhanziy](https://rhanziy.tistory.com/187), [javakorea](https://javakorea.tistory.com/entry/React-native-Codepush-standalone%EC%9C%BC%EB%A1%9C-%EB%B3%80%EA%B2%BD), [velog alsanrlf](https://velog.io/@alsanrlf/AppCenter-%EC%BD%94%EB%93%9C%ED%91%B8%EC%8B%9C-%EB%A7%88%EC%9D%B4%EA%B7%B8%EB%A0%88%EC%9D%B4%EC%85%98). |
| Korean teams → EAS ([velog bbahna](https://velog.io/@bbahna/codepush-eas-update), [atoz-developer](https://atoz-developer.tistory.com/182), [seoin1002](https://velog.io/@seoin1002/%EC%95%B1-%EC%8B%AC%EC%82%AC-%EC%97%86%EC%9D%B4-%EB%B0%B0%ED%8F%AC%ED%95%98%EA%B8%B0-React-Native-Expo-EAS-Update-%EB%8F%84%EC%9E%85)) | CodePush → EAS Update | An urgent replacement. Once set up, "better than CodePush". | Small teams. |
| Korean teams → Revopush ([tomyself-illo](https://tomyself-illo.tistory.com/21)) / hot-updater ([kasumil](https://kasumil.tistory.com/481), [haneui](https://haneui.tistory.com/100)) | CodePush → Revopush / hot-updater | Price and minimal code change (Revopush). Self-hosting and New Architecture support (hot-updater). | Individual blogs. |
| **RAKBANK** (UAE bank), GitHub fork ([rak-hot-updater](https://github.com/trarjun-rakbank/rak-hot-updater)) | → **hot-updater fork** | Inferred: a regulated bank wants OTA on its own infrastructure (unverified). | A fork under an employee account suggests an evaluation or internal use (unverified). |
| Dream Sports / Dream11 (India), GitHub ([dream-horizon-org/code-push-server](https://github.com/dream-horizon-org/code-push-server)) | → forks of code-push-server and react-native-code-push | Suggests self-hosting at a large scale (unverified). | The org also maintains RN infrastructure libraries. |
| LinkedIn post, 2025 ([Aditya Mazumdar](https://www.linkedin.com/posts/aditya-mazumdar_reactnative-otaupdates-hotupdater-activity-7344054957156835330-Gos3)) | App Center → hot-updater + AWS Lambda | Self-hosted control. | |

**Large Korean apps.** No public post was found from Karrot, Kakao, Naver, Woowa (Baemin), Musinsa, Yanolja, Class101, Socar, Ridi, Banksalad, 29CM, Kurly or Zigbang on their CodePush replacement. Korean searches for "CodePush alternative", "CodePush shutdown migration", "adopting hot-updater" and "adopting EAS Update" returned only individual and SMB blogs plus Soomgo and Toss. So how large Korean apps handle this remains **(unverified)**. The pattern that is visible (Soomgo, Toss, the standalone-server posts) is that **Korean teams with real scale build in-house on S3 + CloudFront, or on Azure Korea Central, largely for latency and control**. That is exactly the population that a self-hostable, governed server serves.

**Why teams chose what they chose:**
- **Cost:** hot-updater, self-hosted code-push-server, Revopush.
- **Control and latency:** in-house builds such as Soomgo and Toss.
- **New Architecture:** the forcing function away from the stock client (dragon-developer, Soomgo's remaining work).
- **Least change:** CodePush-compatible hosts and code-push-server.
- **SLA and "someone else runs it":** EAS.
- **Compliance** was not the *stated* driver in any public Korean post, though Soomgo's "no developer AWS keys" design is a compliance-flavoured control.

## 3. Pricing and packaging, 2026, normalized

**Assumptions.** "MAU" means a device that downloads at least one update in the month. Traffic is 2 releases/month × ~3 MB compressed full bundle ≈ **6 MB per MAU per month** (≈1–2 MB with diffs). Update checks are about 30 per MAU per month. List prices in USD per month. Prices that could not be verified are marked.

| Product (source) | 10K MAU | 100K MAU | 1M MAU | Governance at that price |
|---|---|---|---|---|
| **EAS Update** ([pricing](https://expo.dev/pricing), [usage](https://docs.expo.dev/billing/usage-based-pricing/)) | Starter $19 + 7K × $0.005 = **$54**. Signing needs Production: **$199**. | Production $199 + 50K × ≤$0.005 = **≤$449** (graduated rates lower it) | Enterprise, custom. ~$3.8K by [Codemagic's estimate](https://blog.codemagic.io/react-native-ota-tools-in-2026/). Production-path math gives $1.0K–$4.9K. | Signing and SSO on Production+. Audit logs on Enterprise only. No approvals. `EXPO_TOKEN` in CI. |
| **Revopush** ([pricing](https://revopush.org/pricing)) | Startup **$25** | Growing **$100** | Professional **$500** (+~$30 egress above 5 TB) | No signing, audit or RBAC listed on any tier. SSO on Enterprise. |
| **Stallion** ([pricing](https://stalliontech.io/pricing)) | Free (**$0**, capped at 50 GB. Tight without patches.) | Pro **$51** yearly / $64 monthly | Enterprise, custom | Audit, RBAC, SSO, SOC 2 Type I and on-prem are Enterprise only. |
| **Codemagic CodePush** ([pricing](https://codemagic.io/pricing/)) | PAYG 20K installs ÷ 2,500 = **~$8** | **$99** fixed (or ~$80 PAYG) | **$990** (10 × $99 per 100K) | SOC 2 Type 2. No approvals advertised. |
| **Codemagic Patch** (self-host, FSL) ([repo](https://github.com/codemagic-ci-cd/codemagic-patch)) | own infrastructure | own infrastructure | own infrastructure | Roles and an audit table. No N-of-M approval (unverified). |
| **Bitrise CodePush** ([docs](https://docs.bitrise.io/en/release-management/codepush/about-codepush)) | **$0** | **$0** (exactly at the cap). $294 at 250K. | **$1,111** | Claims audit trail and RBAC. Approvals exist for *store* releases in Release Management, not confirmed for OTA (unverified). |
| **AppZung** ([FAQ](https://appzung.com/faq/)) | unpublished | unpublished | unpublished | Signing, EU hosting. |
| **Appcircle CodePush** ([page](https://appcircle.io/codepush)) | unpublished | unpublished | unpublished | Claims audit, RBAC, SSO, self-host. |
| **Pushy** ([pricing](https://pushy.react-native.cn/pricing.html)) | Premium ¥2,400/yr ≈ **$28** (100K checks/day) | Professional ¥7,200/yr ≈ **$83** (1M checks/day) | Pro plus extra checks at ¥100 per 100K/day. Order of $1K+ (unverified). | None. |
| **Capgo** (Capacitor, for reference; [pricing](https://capgo.app/pricing/) per ota-competitors.md) | Maker **$39** | Team **$99** | Enterprise **$249+** | SSO, audit and SOC 2 on Enterprise. |
| **hot-updater on Cloudflare** (Workers $5 includes 10M requests, +$0.30 per million; R2 $0.015/GB-month with **free egress**; D1 included; [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/)) | **~$5** | **~$5** (3M checks, 600 GB egress free) | **~$11–20** (30M checks → +$6, storage cents) | None built in. Access equals whoever holds the Cloudflare or DB credentials. |
| **hot-updater on Supabase** (Pro $25 includes 250 GB egress + 250 GB cached egress, then $0.09 / $0.03 per GB, 2M function calls then $2 per million; [pricing](https://supabase.com/pricing)) | **$25** | **~$30–57** (600 GB, depending on cache hit rate) | **~$200–560** (6 TB, plus 28M calls ≈ $56) | None. |
| **hot-updater / code-push-server on AWS** (S3 + CloudFront + Lambda@Edge) | ~$1–15 | ~$50–75 (600 GB at roughly $0.085–0.12/GB, Korea higher; unverified) | ~$500–700, or a CloudFront flat-rate plan from $200 to $1,000/mo ([pricing](https://aws.amazon.com/cloudfront/pricing/)) | None. |

**Per 1K MAU at 1M MAU:**

| Product | $ per 1K MAU |
|---|---|
| Cloudflare self-host | ~$0.02 |
| Capgo | ~$0.25 |
| Revopush | ~$0.53 |
| Codemagic | ~$0.99 |
| Bitrise | ~$1.11 |
| EAS Update | ~$3.8 (estimate) |

**What this means for pricing.** Bandwidth is a commodity close to zero on Cloudflare. **Nobody can win on delivery price. Bitrise gives away 100K MAU, and Cloudflare self-host costs about $5.** The real self-host cost is engineering time: on-call, upgrades, and incidents like the ones in §4. Governance features are universally gated to "Enterprise, contact sales".

## 4. What customers complain about

- **Stock client stuck on the old architecture.** Issues include "When can we expect new arch support?" ([#2797](https://github.com/microsoft/react-native-code-push/issues/2797), 18 comments), bridgeless support ([#2696](https://github.com/microsoft/react-native-code-push/issues/2696), [#2742](https://github.com/microsoft/react-native-code-push/issues/2742)), an Android New Architecture break ([#2781](https://github.com/microsoft/react-native-code-push/issues/2781)), and "Is this library dying?" ([#2812](https://github.com/microsoft/react-native-code-push/issues/2812)). Codemagic's fork only supports the New Architecture from RN 0.82 on (v10.4+) (README).
- **Shutdown confusion.** Users asked how old apps behave after 2025-03-31 ([#2810](https://github.com/microsoft/react-native-code-push/issues/2810)). One reported that deploys "worked on April 7 and failed today" ([OKKY](https://okky.kr/questions/1532519)). A migration guide warns that stale endpoints are "failing silently right now" ([rnpush](https://rnpush.com/blog/codepush-shutdown-migration-guide)).
- **Self-host reliability (hot-updater's most-discussed issues):**
  - Channels not working ([#232](https://github.com/gronxb/hot-updater/issues/232), 38 comments).
  - The Android app closing after an update download ([#453](https://github.com/gronxb/hot-updater/issues/453), 38).
  - Android updates failing on the Cloudflare provider ([#566](https://github.com/gronxb/hot-updater/issues/566), 34).
  - An infinite reload loop on iOS with Firebase ([#720](https://github.com/gronxb/hot-updater/issues/720), 25, titled "Urgent").
  - The same update offered repeatedly ([#584](https://github.com/gronxb/hot-updater/issues/584)).
  - Fingerprint mismatch after every build ([#437](https://github.com/gronxb/hot-updater/issues/437)).
  - These show that **rollout and rollback correctness is where self-hosted OTA hurts**. hot-updater's newer launch-recovery work (PR #1322 in the earlier doc) responds to this.
- **expo-updates stability.** Reports include a production crash on launch when expo-updates is present ([#23382](https://github.com/expo/expo/issues/23382), 68), an "Unable to pause activity" crash in 0.075% of sessions ([#35676](https://github.com/expo/expo/issues/35676)), an ANR with many assets ([#19918](https://github.com/expo/expo/issues/19918)), a native crash when an OTA update is available ([#14930](https://github.com/expo/expo/issues/14930)), and an SDK 54 icon-path break ([#39782](https://github.com/expo/expo/issues/39782)).
- **Pricing and lock-in.**
  - EAS bandwidth confuses users ([r/expo](https://www.reddit.com/r/expo/comments/1d4vl2m/understanding_eas_update_global_edge_bandwidth/)) and is called "expensive at scale" ([AppSpacer](https://docs.appspacer.com/blog/7-best-codepush-alternatives)).
  - One Korean team's hot-updater storage costs grew ([FECONF review](https://developer-dreamer.tistory.com/183)). A Korean developer blog calls EAS "Expo-specific and expensive" ([velog](https://velog.io/@jingjing2222/hot-updater-open-sourse)).
  - Stallion is criticized for "proprietary SDK lock-in" ([akshatsethi](https://akshatsethi.com/posts/codepush-alternatives-in-2026/)).
  - The r/reactnative threads on "alternatives after App Center" are the general-demand signal ([1](https://www.reddit.com/r/reactnative/comments/1dsorxn/end_of_appcenter_x_codepush_for_2025_march/), [2](https://www.reddit.com/r/reactnative/comments/1cgasy6/are_there_any_alternative_codepush_solution/), [3](https://www.reddit.com/r/reactnative/comments/1dh7955/is_there_a_need_for_eas_update_alternative/)). The Reddit API was blocked, so these are titles and snippets only.
- **Vendor churn.** Two OTA vendors exited in two years (App Center, then Appflow per the earlier doc). Soomgo also had a latency complaint about App Center serving Korea.
- **Approvals, audit and CI tokens.** No public complaint thread was found that explicitly asks for OTA approvals (unverified). The evidence is behavioural instead:
  - Soomgo built GitHub-Actions-only deploys so developers hold no keys.
  - Codemagic Patch added an explicit "approve fingerprint mismatch" step.
  - Every enterprise tier now advertises audit and RBAC.
  - Expo CI guidance is still "create your `EXPO_TOKEN` GitHub secret" ([expo-github-action](https://github.com/expo/expo-github-action)).
  - Hosted CodePush clients embed per-environment deployment keys (`IOS_CODE_PUSH_DEPLOYMENT_KEY`) ([Rewind](https://thereactnativerewind.com/guides/skipping-the-app-store-review-queue-with-bitrise-codepush)).
  - Governance is a *buying-committee* requirement (security, audit), not a developer complaint. Mocco's messaging has to reach both audiences.

## 5. Regulated industries

**Control frameworks that treat an OTA push as a production change:**
- **SOC 2 CC8.1**: "The entity authorizes, designs, develops or acquires, configures, documents, tests, **approves**, and implements changes to … software" ([summary](https://www.auditfront.com/frameworks/soc-2/common-criteria/cc8-1/)). Auditors test for separate approval and evidence of it ([guide](https://soc2-auditors.com/insights/soc-2-change-management)).
- **ISO/IEC 27001:2022 A.8.32 Change management**: changes are "planned, assessed, authorised, tested, documented" ([ISMS.online](https://www.isms.online/iso-27001/annex-a-2022/8-32-change-management-2022/)).
- **PCI DSS 4.0.1 Req. 6.5.1**: a documented reason, a security impact review, **authorized approval**, testing and a rollback path ([summary](https://learn.daydream.ai/requirements/pci-dss-6-5-1)).
- **HIPAA 45 CFR 164.312(b)** audit controls, which "record and examine activity" in systems handling ePHI ([eCFR](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312)). That applies directly only when the app touches PHI; the OTA pipeline is in scope as a system that changes that app (interpretation).

**Korea:**
- **Electronic Financial Supervisory Regulation, Art. 29 (program control)**.
  - Current text, amended on 2025-02-05 to a principle-based rule: financial companies and electronic financial business operators "must establish and operate procedures for program registration, change and retirement that include the matters set by the FSS Governor" ([Wikisource, notice 2025-4](https://ko.wikisource.org/wiki/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95_(%EC%A0%9C2025-4%ED%98%B8))). The latest in-force version is 2026-07-15 ([law.go.kr](https://law.go.kr/%ED%96%89%EC%A0%95%EA%B7%9C%EC%B9%99/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95)).
  - The pre-2025 enumerated version spells out what those procedures contain ([itwiki](https://itwiki.kr/w/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95_%EC%A0%9C29%EC%A1%B0)): **record content before and after a change**, **third-party verification that the change is legitimate**, application to production only after testing and **approval by the responsible officer**, **the person who registers a change must differ from the developer**, and access limited to assigned staff. That is almost exactly Mocco's gate (`prevent_self`, N-of-M, reason) plus audit.
  - Industry guidelines turn this into operations: the Korea Financial Investment Association and the Korea Fintech Industry Association publish a program control guideline ([KOFIA](https://law.kofia.or.kr/service/law/lawFullScreenContent.do?seq=359&historySeq=1591), [Korfin PDF](http://korfin.kr/download.php?FIDX=793)). It requires emergency-change procedures in internal rules and a verification procedure.
  - A 2026-05 practitioner guide adds the operating detail ([a-fin](https://a-fin.co.kr/insights/electronic-finance-regulation-developer-guide)). Checks happen **at least quarterly**. The approver is pre-designated and cannot be changed ad hoc. "Without evidence it didn't happen." **Emergency deploys without post-hoc approval are an audit finding.**
- **Electronic Financial Supervisory Regulation, Art. 34(4)**: the company must provide a way to verify the **integrity (tampering) of the electronic financial transaction program** it provides to users (same source). OTA bundle signing and a verifiable release record map directly onto this.
- **ISMS-P 2.8.6 (migration to production)**: moving a new or changed system into production "must follow a controlled procedure". A cited defect case is having no review or approval step when source is promoted to production ([JLabs](https://www.jlabs.kr/isms-p/criteria/2.8.6), [itwiki](https://new.itwiki.kr/w/ISMS-P_%EC%9D%B8%EC%A6%9D_%EA%B8%B0%EC%A4%80_2.8.6.%EC%9A%B4%EC%98%81%ED%99%98%EA%B2%BD_%EC%9D%B4%EA%B4%80)).
- **Gap.** No Financial Security Institute (FSI) or Financial Supervisory Service (FSS) guidance was found that addresses **app hot updates / CodePush specifically** (unverified). The FSI mobile app checks focus on integrity and tamper protection ([summary](https://super-dt.tistory.com/295)). Whether an RN OTA bundle counts as a "program change" under Art. 29 is an interpretation, but a conservative CISO would treat it as one. Mocco should validate this with one Korean fintech's security team before relying on it in marketing.

**Competitors marketing to regulated buyers:**
- Stallion Enterprise targets "financial services, healthcare, and government".
- Bitrise claims SOC 2 Type II and PCI DSS.
- Codemagic claims SOC 2 Type 2.
- Appcircle markets itself as "compliance-ready" with self-hosting.
- Expo sells audit logs and SSO on Enterprise ([security](https://expo.dev/security)).
- None of them markets **pre-deploy approval of OTA** or an **evidence export mapped to a named control** (CC8.1, Art. 29, ISMS-P 2.8.6). That is the open lane.

## 6. Go-to-market recommendation

### 6.1 Ideal first customer

**Primary: Korean regulated or ISMS-P-certified RN apps.** Fintech and electronic financial business operators (payment gateways, simple payment, brokerage, insurtech, virtual assets), digital health, and large B2C apps under ISMS-P.
- 50K–2M MAU, 5–30 mobile engineers.
- **Already running an in-house or self-hosted OTA path** (code-push-server, a Soomgo-style S3/CloudFront setup, or hot-updater) because SaaS was too slow from Korea or hard to get past security review.
- Their pain is the quarterly program-control evidence, compiled by hand from Slack and Jira, plus emergency hotfixes that break the approval chain.
- Buyers are the mobile lead plus the CISO or information security officer.

**Secondary: global SOC 2 or PCI startups on EAS Update or a CodePush host.** Their auditor asks "who approved this OTA push?" and they are paying about $199–449/mo, or have hit the "contact sales" wall for audit logs.

**Not a first customer:** hobby and SMB apps. Bitrise's free 100K and $5 Cloudflare self-host make that segment unwinnable on price.

### 6.2 Wedge: govern first, host second

1. **"Gate your existing OTA" (weeks, not quarters).**
   - A Mocco run holds the broker-issued credential for the customer's current OTA provider: `EXPO_TOKEN`, a Revopush or CodePush access key, or hot-updater's cloud credentials. `eas update --channel production`, `revopush release` or `hot-updater deploy -c production` then runs only after the gate passes (N-of-M approvers, `prevent_self`, reason required, emergency path with **mandatory post-hoc approval**).
   - Every step is written to the hash-chained audit log.
   - No client change and no migration. It removes long-lived tokens from CI immediately (GitHub OIDC to Mocco, then Mocco's broker to the provider).
   - This reuses what Mocco already has and matches Soomgo's home-built "no developer keys" pattern.
2. **Mocco OTA hosting (Expo protocol)**, the existing v1 plan, for teams that want to consolidate.
3. **A CodePush-compatible endpoint. Move it from "v2 maybe" to v1.x**, because the CodePush-protocol population (~412K downloads/month, including 117K on the archived stock client) is at least 1.5× every non-Expo alternative combined. Serve `updateCheck`, `reportStatus/deploy` and `reportStatus/download` for `@code-push-next`, `@revopush`, `@bravemobile` and the stock clients. Customers then change only `CodePushServerURL` (for example in `Info.plist`) and keep their SDK.
4. **Import tools:**
   - `mocco ota import codepush`: reads code-push-server storage or the standalone CLI's `deployment history` and recreates deployments, labels, target binary ranges and rollout state.
   - `mocco ota import eas`: from `eas update:list --json` and `eas channel:list`.
   - `mocco ota import hot-updater`: reads its Supabase, D1 or Postgres bundles table.
   - Imported history enters the audit chain as a signed "genesis import" record.
5. **hot-updater cooperation over competition (Korea).** hot-updater is Korean-born, award-winning, has a Toss engineer as maintainer, and has a plugin architecture. A `@mocco/hot-updater-plugin` (database or deploy plugin that enforces Mocco gates and audit) would put Mocco inside the fastest-growing self-host community rather than against it. Approaching the maintainer about this is worth doing early (unverified appetite).

### 6.3 Pricing proposal

Charge for governance, not bandwidth. Delivery at list price stays below Revopush and Bitrise.

| Tier | Price | Includes | 10K | 100K | 1M |
|---|---|---|---|---|---|
| **Self-host** (AGPL) | $0 | Everything, including gates, hash-chained audit, OIDC and signing | $0 | $0 | $0 (plus about $5–20 infrastructure on Cloudflare R2) |
| **Cloud Free** | $0 | 10K MAU, 1 protected channel, 1-of-1 gate, 30-day audit | $0 | – | – |
| **Cloud Team** | $49/mo | 50K MAU, unlimited protected channels, N-of-M gates, OIDC publishing, signing, 1-year audit; $0.50 per extra 1K MAU | **$49** | **$74** | **$524** |
| **Cloud Regulated** | $490/mo | 250K MAU, SSO/SAML, audit export (SIEM, WORM/S3 Object Lock), a **control-mapped evidence pack** (SOC 2 CC8.1, ISO A.8.32, PCI 6.5.1, Electronic Financial Supervisory Regulation Art. 29, ISMS-P 2.8.6) with a Korean-language report, Seoul-region data residency, 99.9% SLA; $0.30 per extra 1K MAU | – | **$490** | **$715** |
| **Enterprise / on-prem support** | Annual, KRW contract | On-prem or air-gapped (network separation) install, support SLA, onboarding and import | – | – | Custom (market check needed: unverified) |

Sanity check at 1M MAU:

| Product | Monthly price |
|---|---|
| Mocco Team | $524 |
| Revopush | $500 |
| Mocco Regulated | $715 |
| Codemagic | $990 |
| Bitrise | $1,111 |
| EAS Update | ~$3.8K |

At 100K MAU, Mocco Team costs $74 against Bitrise $0, Revopush $100 and EAS ≤$449. **The "Gate your existing OTA" wedge should also sell standalone**, priced per protected app (for example $29 per app per month, or bundled with Mocco seats), because it does not touch delivery at all. Offer KRW billing and Korean tax invoices.

### 6.4 Migration offer (launch package)

- **"Switch in one line."** The CodePush-compatible endpoint plus `mocco ota import codepush`. Free for 3 months for App Center refugees who are still on the stock `react-native-code-push` (the 117K-downloads-a-month population) and must move off it before adopting the New Architecture.
- **"Keep EAS, add approvals."** The gate-and-broker wedge for Expo teams. Upgrade to Mocco hosting later, with no client change because Mocco speaks the Expo protocol.
- **"Audit-ready in a day."** An evidence export template for the next quarterly program-control check or SOC 2 window. Validate it with one friendly auditor or information security officer before launch.

### 6.5 Korean market angle

- **Latency.** Soomgo's 1.5 s → 0.3 s result shows that serving from Seoul is a visible user benefit. Host at the edge with an explicit ICN point of presence and publish p90 update-check times from Korea.
- **Regulatory language.** Frame Mocco as applying the Art. 29 program-control rule to OTA (in Korean marketing copy): pre/post change records, third-party verification, a pre-designated approver, separation of developer and deployer, and emergency changes with post-hoc approval, plus Art. 34 program integrity through signing.
- **Channels:** FECONF, the Toss SLASH community, GeekNews (hot-updater's launch landed there, [link](https://news.hada.io/topic?id=18759)), velog and tistory SEO for Korean queries meaning "CodePush alternative" and "CodePush shutdown migration", which today are dominated by individual blogs, and ISMS-P consultants.
- **Risk.** Large Korean apps (Toss, likely others) already built in-house platforms. Sell self-hosted governance to them (AGPL plus a support contract), not hosting. The quickest first logos are likely mid-size fintechs and health apps (unverified).

## Open questions / not verified

- Microsoft's CodePush app and user counts. Revopush's customer count.
- How much of the 2026 npm inflation is bots, and whether it distorts the shares.
- Bitrise CodePush: whether its RBAC and audit claim includes **approval before an OTA deploy**. Its overage policy.
- Appcircle and AppZung price points.
- Whether FSS or FSI examiners treat RN OTA bundles as Art. 29 "programs". Whether financial-sector cloud rules require an FSI cloud safety assessment of the provider for a hosted OTA vendor.
- Which large Korean apps (Karrot, Kakao, Woowa, Musinsa and others) use which OTA stack.

## Sources (additional to ota-competitors.md)

npm API (`api.npmjs.org/downloads/range/…`, `registry.npmjs.org/…`); GitHub API (repo metadata and issue search); github.com/…/network/dependents.
https://bitrise.io/platform/codepush · https://bitrise.io/blog/post/ship-react-native-updates-in-minutes-codepush-on-bitrise-is-now-live · https://docs.bitrise.io/en/release-management/codepush/about-codepush · https://thereactnativerewind.com/guides/skipping-the-app-store-review-queue-with-bitrise-codepush · https://github.com/codemagic-ci-cd/react-native-code-push · https://github.com/codemagic-ci-cd/codemagic-patch · https://codemagic.io/pricing/ · https://systemsdigest.com/videos/numbers-behind-codemagic-codepush · https://appcircle.io/codepush · https://news.ycombinator.com/item?id=44712460 · https://appzung.com/faq/ · https://github.com/appzung/react-native-code-push · https://pushy.react-native.cn/pricing.html · https://stalliontech.io/pricing · https://stalliontech.io/trust · https://stalliontech.io/enterprise · https://revopush.org/pricing · https://saasbrowser.com/en/saas/645960/revopush · https://expo.dev/pricing · https://docs.expo.dev/billing/usage-based-pricing/ · https://docs.expo.dev/accounts/audit-logs/ · https://expo.dev/changelog/2024-08-21-audit-logs-available · https://docs.expo.dev/accounts/programmatic-access/ · https://expo.dev/security · https://github.com/expo/expo-github-action · https://expo.dev/blog/how-to-replace-app-center-and-codepush · https://developers.cloudflare.com/r2/pricing/ · https://developers.cloudflare.com/workers/platform/pricing/ · https://supabase.com/pricing · https://aws.amazon.com/cloudfront/pricing/ · https://soomgo.team/blog/posts/67846d14271b0f4d3124ffb4 · https://toss.tech/article/react-native-2024 · https://github.com/toss/granite · https://techchat-apps-in-toss.toss.im/t/ci-cd/1632 · https://developer-dreamer.tistory.com/183 · https://www.oss.kr/opensource/hub/56946 · https://news.hada.io/topic?id=18759 · https://dragon-developer.tistory.com/81 · https://izizi.tistory.com/63 · https://rhanziy.tistory.com/187 · https://velog.io/@bbahna/codepush-eas-update · https://atoz-developer.tistory.com/182 · https://tomyself-illo.tistory.com/21 · https://kasumil.tistory.com/481 · https://velog.io/@jingjing2222/hot-updater-open-sourse · https://github.com/trarjun-rakbank/rak-hot-updater · https://github.com/dream-horizon-org/code-push-server · https://akshatsethi.com/posts/codepush-alternatives-in-2026/ · https://docs.appspacer.com/blog/7-best-codepush-alternatives · https://rnpush.com/blog/codepush-shutdown-migration-guide · https://okky.kr/questions/1532519 · https://appisto.app/blog/app-center-retirement-migration-guide · https://visualstudiomagazine.com/articles/2024/03/18/app-center-retirement.aspx · https://github.com/microsoft/react-native-code-push/issues/2797 · https://github.com/microsoft/react-native-code-push/issues/2812 · https://github.com/microsoft/react-native-code-push/issues/2781 · https://github.com/gronxb/hot-updater/issues/232 · https://github.com/gronxb/hot-updater/issues/453 · https://github.com/gronxb/hot-updater/issues/566 · https://github.com/gronxb/hot-updater/issues/720 · https://github.com/expo/expo/issues/23382 · https://github.com/expo/expo/issues/35676 · https://www.reddit.com/r/expo/comments/1d4vl2m/understanding_eas_update_global_edge_bandwidth/ · https://www.reddit.com/r/reactnative/comments/1dsorxn/end_of_appcenter_x_codepush_for_2025_march/ · https://www.auditfront.com/frameworks/soc-2/common-criteria/cc8-1/ · https://www.isms.online/iso-27001/annex-a-2022/8-32-change-management-2022/ · https://learn.daydream.ai/requirements/pci-dss-6-5-1 · https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312 · https://ko.wikisource.org/wiki/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95_(%EC%A0%9C2025-4%ED%98%B8) · https://law.go.kr/%ED%96%89%EC%A0%95%EA%B7%9C%EC%B9%99/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95 · https://itwiki.kr/w/%EC%A0%84%EC%9E%90%EA%B8%88%EC%9C%B5%EA%B0%90%EB%8F%85%EA%B7%9C%EC%A0%95_%EC%A0%9C29%EC%A1%B0 · https://law.kofia.or.kr/service/law/lawFullScreenContent.do?seq=359&historySeq=1591 · http://korfin.kr/download.php?FIDX=793 · https://a-fin.co.kr/insights/electronic-finance-regulation-developer-guide · https://www.jlabs.kr/isms-p/criteria/2.8.6 · https://super-dt.tistory.com/295
