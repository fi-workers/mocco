---
title: Smart deep links — competitor research
description: Competitive landscape for smart deep links with deferred deep linking after the Firebase Dynamic Links shutdown, and where Mocco should position its links product (issue #102).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, deep-links]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-deep-links-design.md
---

# Smart deep links — competitor research

## Summary

Firebase Dynamic Links (FDL) stopped working on 2025-08-25; every FDL link now returns HTTP 404 and the
analytics/short-link APIs return 400/403 [1]. Google's own FAQ points teams either to native App Links /
Universal Links (hosting the association files themselves) or to seven third parties: Adjust, Airbridge,
AppsFlyer, Bitly, Branch, Kochava and Singular [1]. The market that absorbed FDL users has split into three
camps: (a) mobile measurement partners (MMPs: AppsFlyer, Branch, Adjust, Kochava, Singular, Airbridge) that
bundle linking with paid-ad attribution and sell on sales-led, MAU- or conversion-based contracts; (b) link
managers (Bitly, Rebrandly, Short.io, Dub, URLgenius) that grew "deep link" features but mostly gate them behind
mid/upper tiers and often only do platform redirects, not verified app links; and (c) a new wave of cheap
"FDL replacement" tools (ChottuLink, Linkrunner, Flinku, Ulinkly, Tolinku, AppsOnAir AppLink) priced at
$0–$99/month with generous MAU-based free tiers. The technical core is commoditised: host AASA/assetlinks on a
custom domain, redirect by platform, recover the link after install via Play Install Referrer on Android and
clipboard or IP matching on iOS. The real differentiation left is (1) trustworthy iOS deferred behaviour that
does not violate Apple's "no deriving data to uniquely identify a device" rule [2], (2) abuse controls on a
redirect service, (3) developer ergonomics (API-first runtime link creation, RN SDK, OG previews that work in
Korean in-app browsers like KakaoTalk), and (4) pricing that does not require an MMP contract. Mocco should ship
a developer-first, attribution-light link router that is priced as part of the Mocco bundle, is self-hostable
(only Dub is also open source), and is release-aware — it knows which app build is in production and can route
users on old builds to "update" instead of a broken screen.

## Market map

| Segment | Players | Buyer | Pricing model |
|---|---|---|---|
| MMP suites with deep linking | AppsFlyer OneLink, Branch, Adjust, Kochava SmartLinks, Singular Links, Airbridge (AB180) | Growth / UA marketing teams with paid-ad budgets | Sales-led; per conversion, per MAU, or volume credits; free tiers capped by installs/conversions |
| Link management / shorteners with "deep links" | Bitly, Rebrandly, Short.io, Dub (open source) | Marketing, social, creators; Dub targets developers | Self-serve tiers by links/clicks/domains; deep links on upper tiers |
| Social / app-to-app deep linkers | URLgenius, GeniusLink, JotURL | Creators, affiliates (open Amazon/YouTube/TikTok apps) | Per click |
| FDL-replacement indie tools | ChottuLink, Linkrunner, Flinku, Ulinkly, Tolinku, AppsOnAir AppLink, Deeplinkly | Indie and small app teams migrating from FDL | $0–$99/mo flat by MAU, or per install |
| Do-it-yourself native | Apple Universal Links, Android App Links (incl. Android 15 Dynamic App Links), Firebase Hosting for association files | Engineering teams | Free, but no deferred linking, no analytics, no fallbacks |

## Competitor profiles

### AppsFlyer OneLink (deep)

- **What it is:** The linking module of AppsFlyer, the largest MMP. OneLink templates on a `*.onelink.me` subdomain
  or a branded domain; short links, QR, social-to-app landing pages, Smart Banners / Smart Script (web-to-app),
  deferred deep linking through the AppsFlyer SDK (Unified Deep Linking API).
- **Target:** Mid-to-large consumer apps with paid UA; Google explicitly named AppsFlyer as an FDL alternative [1][3].
- **Pricing (2026):** Zero (free; "welcome package" of 12K free conversions for the first year, core analytics,
  30 days of premium add-ons), Growth (pay-as-you-go, $0.07 per conversion after the welcome package), Enterprise
  (custom) [4]. AppsFlyer's pricing page lists shortlinks, QR, link management, click reporting, social-to-app
  landing pages and deferred deep linking on all three plans; Advanced analytics, Smart Banners / Smart Script and
  the OneLink API are not on Zero [4]. A third-party blog claims an 2026-08-13 refresh moved deferred deep linking,
  branded domains and the OneLink API into paid tiers [5]; this contradicts the live pricing page as fetched on
  2026-09-24 (unverified — treat as a signal of pricing churn, not a fact).
- **Platforms:** iOS, Android, React Native, Flutter, Unity, Web SDK, CTV.
- **Open source / self-host:** No.
- **Strengths:** Market leader, deepest ad-network integrations, fraud protection, mature docs.
- **Weaknesses:** The link API sits behind paid plans; conversion-priced; attribution-first product surface is
  heavy for teams that only want routing; frequent packaging changes.
- **Recent news:** Heavy FDL-migration marketing [3]; pricing packaging changes in 2026 [5] (unverified).

### Branch (deep)

- **What it is:** The company that popularised deferred deep linking; now positioned as a mobile linking plus
  measurement platform (Journeys banners, QR, email deep linking, NativeLink clipboard-based iOS deferred linking).
- **Target:** Mid-market and enterprise consumer apps.
- **Pricing (2026):** The public pricing page shows Basics, Essentials and Enterprise with no dollar figures
  (Basics: 3 ad partners / 3 webhooks / 3 postbacks; Essentials and Enterprise unlimited) [6]. Third-party
  estimates: a free "Launch" tier up to 10K MAU, paid entry around $199–$499/month on "volume credits", and
  annual contracts of $15K–$35K for 50K–150K MAU up to $75K–$250K+ for enterprise [7][8] (estimates, unverified).
- **Platforms:** iOS, Android, React Native, Flutter, Unity, Cordova/Capacitor, Web.
- **Open source / self-host:** No.
- **Strengths:** Link reliability across in-app browsers and email clients, strong deferred deep link reputation,
  Branch app.link domain trusted by platforms.
- **Weaknesses:** Opaque sales-led pricing, repeated packaging changes; attribution upsell.
- **Recent news:** States it will not provide device-level ad attribution on iOS before ATT consent, but still
  loads the SDK for "UX and analytics" deep linking without ATT [9].

### Airbridge (AB180, Korea) (deep)

- **What it is:** Airbridge is the MMP built by AB180 (Seoul, founded 2015), the only MMP headquartered in Asia
  [10]. It bundles attribution, deep linking (`abr.ge` short domain or custom domain), deferred deep linking,
  QR codes, web-to-app banners and an "AI Pilot" / MCP server; AB180 is building "Airbridge GO", an AI marketing
  agent [10].
- **Target:** Korean and Asian consumer apps (commerce, fintech, games) and global apps expanding in Asia; 800+
  enterprise clients, 1,000+ apps, 30+ countries; 2025 revenue about KRW 38.4B [10].
- **Pricing (2026):** Current pricing page lists **Core** ($40+/month; 30-day free trial; 500K data points
  included, then $0.0001 per data point; attribution limited to Meta, Google, Apple and TikTok ads; deferred deep
  links, short links and QR, web-to-app banner; 2 integrations; "$40 covers about 35,000 MAU at typical usage")
  and **Growth** (custom, by MAU or installs; 330+ ad networks; raw data export; fraud detection) [11][12]. In
  2025 Airbridge marketed a dedicated **DeepLink Plan**, free under 10K MAU with full deep-link features, custom
  domains, bulk generation from Google Sheets and a link API [13]; third-party reports cite a 3,000-link cap on
  that free tier and $199/month from 11K MAU [14] (unverified). The `/deeplink-plan` URL now resolves to the Core
  plan, so the stand-alone DeepLink Plan appears to have been folded into Core (inferred).
- **Platforms:** iOS, Android, React Native (`airbridge-react-native-sdk`), Flutter, Unity, Web SDK [11].
- **Deferred linking method on iOS:** A layered stack — IDFA when ATT-consented, probabilistic IP + device
  matching ("70–90% in controlled conditions", defeated by iCloud Private Relay), clipboard (near-deterministic
  but needs paste permission), and first-party context embedded in owned-channel links [15].
- **Open source / self-host:** No.
- **Strengths:** Korean-language support and local ad-network integrations (Kakao, Naver), strong local
  sales/support, aggressively cheap entry tier after FDL shutdown, honest public writing on iOS match rates.
- **Weaknesses:** Still an MMP at heart; deep-linking price is tied to "data points"; plan names change often;
  probabilistic matching exposure to Apple policy.
- **Recent news:** $15M Series C led by Atinum Investment (2026-07), for AI/big-data R&D and global expansion [10].

### Dub (open source) (deep)

- **What it is:** Open-core link attribution platform (AGPL-3.0 repo `dubinc/dub`), Next.js on Vercel with
  Tinybird for click analytics; short links, QR, custom domains, conversions, affiliate/partner programs, and since
  2025 **Deep Links** with AASA/assetlinks hosting on the custom domain and iOS / Android / React Native SDKs [16].
- **Target:** Developer-led SaaS and consumer companies; partner/referral programs.
- **Pricing (2026):** Pricing page as fetched shows Business $90/month (10K new links/month, 100 domains, 250K
  tracked events, 3-year retention), Advanced $300/month (50K links, 250 domains, 1M events, 5-year retention),
  Enterprise custom; 10% off yearly [17]. Deep links need "Pro plan or higher" per docs [16]; third-party reviews
  list Free and Pro ($25/month yearly) tiers [18], which may no longer be shown on the page (unverified).
- **Deferred deep linking:** Android via Install Referrer; iOS via a hybrid — deterministic clipboard copy when the
  user taps "Get the App", and probabilistic IP-based matching when they choose "Get the App without Copying";
  one `/track/open` endpoint returns `{ clickId, link: { id, url } }` [19].
- **Open source / self-host:** Yes (AGPL-3.0), but self-hosting requires Vercel-style infra plus Tinybird and
  Upstash (from the repo's docs; unverified in this session).
- **Strengths:** Best developer experience, clean API, public codebase, fast edge redirects.
- **Weaknesses:** Deep links arrived late and are not the core product; iOS IP matching is exposed to Apple's
  fingerprinting rule; pricing jumps quickly with events.
- **Recent news:** Continued expansion into partner/affiliate payouts (visible in pricing limits [17]).

### ChottuLink (deep, the loudest FDL replacement)

- **What it is:** A Firebase Dynamic Links look-alike built explicitly for FDL migrants [20].
- **Pricing (2026):** Forever Free $0 up to 25K MAU; Indie $19/month (25K–100K MAU); Growth $39/month
  (100K–1M MAU, advanced analytics, Slack support); Scale $99/month (1M+ MAU, SLA). All plans: unlimited links,
  clicks and QR, deferred deep linking, custom domain, REST APIs, attribution [21].
- **Platforms:** iOS, Android, Flutter, React Native, Unity, Capacitor [21].
- **Open source / self-host:** No.
- **Strengths:** Price, FDL-shaped API, migration content.
- **Weaknesses:** Small vendor (AWS-hosted), business durability risk — the exact risk FDL users just lived through.

### Adjust

- MMP (owned by AppLovin since 2021). Free **Base** plan: all Core features up to 1,500 monthly attributions for up
  to 12 months; **Core** up to 250K annual attributions; **Enterprise** above; no dollar prices published [22].
  Deep links via Adjust "TrueLink"/link templates with deferred deep linking in the SDK (feature naming
  unverified). SDKs: iOS, Android, RN, Flutter, Unity, Web. Closed source. Strength: attribution depth.
  Weakness: tiny free tier for pure linking.

### Kochava

- MMP with **Free App Analytics** (100% free, up to 10K attributed conversions/month, no card) including
  **SmartLinks** multi-platform deep links and deferred deep linking [23]. Closed source. Strength: most generous
  free MMP linking. Weakness: dated UX, attribution-centric.

### Singular

- MMP with **Singular Links**. Free plan up to 15,000 paid conversions, then a per-conversion Growth plan and
  quote-based Enterprise; free plan includes deep linking [24] (third-party summary). Closed source.

### Bitly

- The largest shortener. Free (5 links/month, 2 QR), Core, Growth ($35/month or $29 annual; first tier with a
  custom domain, 500 links/month, 4 months of data), **Premium** ($300/month or $199 annual; 3,000 links, 1 year of
  data, city-level analytics and **mobile deep linking**), Enterprise (~$10K+/year) [25]. Named by Google as an FDL
  alternative [1]. Closed source. Weakness: deep links only at $199+/month; no RN deferred SDK of note.

### Short.io

- Free (1,000 branded links, 50K tracked clicks/month, 5 domains), Hobby $5, Pro $18 (unlimited clicks), Team $48
  (**deep linking**, 50 domains, 99.9% SLA), Enterprise $148 (SSO, S3 export); API on every plan [26]. Closed
  source. Deep linking is redirect-level, no deferred SDK (unverified).

### Rebrandly

- Free (10 links/month, 100 tracked clicks), Essentials $13 ($8 annual), Professional $32 ($22), Growth $99 ($69,
  3,500 links, 150K tracked clicks, 10 domains), Enterprise custom with 99.99% SLA [27]. Closed source. Tracked
  clicks are hard-capped per tier — analytics disappear above the cap.

### URLgenius

- App-to-app deep linker for creators and affiliates: opens 120+ third-party apps (Amazon, YouTube, TikTok,
  Instagram) without an SDK; first 500 clicks free then $0.01/click, a Power Plan from $99/month [28]. Different
  job (opening other people's apps), not a fit for first-party app routing; relevant only as a pricing reference.

### Linkrunner

- Attribution plus deep links aimed at emerging-market app teams. Deep links from $24/month billed annually with
  unlimited links; attribution usage-priced: 25,000 one-time free attributed installs, then $0.012–$0.007 per
  install; manages custom domain, AASA/assetlinks and SSL; SDKs for iOS, Android, RN, Flutter, Expo, Capacitor
  [29][30]. Closed source.

### Other FDL replacements

- **Flinku, Ulinkly (ulink.ly), Tolinku, Deeplinkly, AppsOnAir AppLink, 1link.io:** small tools publishing
  comparison content and $0–$50/month plans (from search listings [7][31]; individual prices unverified).
- **Do-it-yourself:** Google recommends App Links / Universal Links with association files on Firebase Hosting
  when you only need post-install deep links [1]. Android 15+ adds **Dynamic App Links**: path, query and fragment
  rules plus exclusions in `assetlinks.json` (`dynamic_app_link_components`), refreshed by Play services about
  weekly, ignored on older Android [32].

## Feature matrix

Legend: Y = yes, P = partial / upper tier only, N = no, ? = unverified.

| Capability | OneLink | Branch | Airbridge | Adjust | Kochava | Singular | Dub | ChottuLink | Linkrunner | Bitly | Short.io | Rebrandly | Mocco v1 (proposed) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Custom link domain | P | Y | Y | Y | Y | Y | Y | Y | Y | P | Y | Y | Y |
| AASA/assetlinks hosting | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | ? | N | Y |
| Per-platform fallbacks | Y | Y | Y | Y | Y | Y | Y | Y | Y | P | P | P | Y |
| Deferred deep link (Android referrer) | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | N | N | Y |
| iOS deferred: clipboard | ? | Y (NativeLink) | Y | ? | ? | ? | Y | ? | ? | N | N | N | Y (opt-in UI) |
| iOS deferred: IP/probabilistic | Y | Y | Y | Y | Y | Y | Y | ? | ? | N | N | N | N (off; see design) |
| OG preview per link | Y | Y | Y | ? | ? | ? | Y | Y | ? | P | Y | Y | Y |
| QR codes | Y | Y | Y | ? | ? | ? | Y | Y | Y | Y | Y | Y | Y |
| Runtime link-creation API | P (paid) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| React Native SDK | Y | Y | Y | Y | Y | Y | Y | Y | Y | N | N | N | Y |
| Paid-ad attribution / SKAN | Y | Y | Y | Y | Y | Y | N | N | Y | N | N | N | N |
| Open source / self-host | N | N | N | N | N | N | Y | N | N | N | N | N | Y |
| Release-aware routing (min app build) | N | N | N | N | N | N | N | N | N | N | N | N | Y |
| Governed/audited link-domain changes | N | N | N | N | N | N | N | N | N | N | N | N | Y |

## Pricing comparison

| Vendor | Free tier | Entry paid | Pricing unit | Deep links / deferred on entry tier |
|---|---|---|---|---|
| AppsFlyer | Zero: 12K conversions in year 1 | Growth $0.07/conversion | Conversions | Deferred yes; API no on Zero [4] |
| Branch | ~10K MAU "Launch" (third-party) | ~$199–$499/month (third-party) | Volume credits / MAU | Yes [7][8] |
| Airbridge | 30-day trial (Core); formerly free <10K MAU | Core $40+/month | Data points ($0.0001) | Yes [11][13] |
| Adjust | 1,500 attributions/month for 12 months | Custom | Attributions | Yes [22] |
| Kochava | 10K conversions/month forever | Custom | Conversions | Yes [23] |
| Singular | 15K paid conversions | Per conversion | Conversions | Yes [24] |
| Dub | Free (third-party) | Business $90/month (page) | Links + tracked events | Deep links Pro+ [16][17] |
| ChottuLink | 25K MAU forever | $19/month | MAU | Yes [21] |
| Linkrunner | 25K installs one-time | $24/month (deep links) | Installs | Yes [29][30] |
| Bitly | 5 links/month | $29–$35/month | Links | Deep links $199+/month [25] |
| Short.io | 1,000 links, 50K clicks | $5/month | Links / clicks | Deep links $48+/month [26] |
| Rebrandly | 10 links, 100 clicks | $8–$13/month | Links / clicks | Limited [27] |
| URLgenius | 500 clicks | $0.01/click | Clicks | Third-party apps only [28] |

## Gaps and opportunities for Mocco

1. **Durability and exit path.** FDL users were burned by a shutdown; ChottuLink-style tools repeat the risk.
   Mocco being AGPL and self-hostable (links keep resolving if the customer runs it themselves, and the domain is
   theirs) is a direct answer. Only Dub competes here.
2. **Honest iOS deferred linking.** Apple forbids deriving device data "for the purpose of uniquely identifying
   it" and may reject apps that reference SDKs doing so [2]; most vendors still run IP/UA matching. A
   deterministic-only default (App Store fallback via a landing page that offers clipboard handoff, plus
   authenticated handoff when the user logs in) with transparent reporting of "unmatched installs" is a
   defensible, reviewable position — and a selling point for privacy-sensitive Korean fintech/health apps.
3. **Routing without an MMP.** Most teams need links for share buttons, support, email and QR — not ad
   attribution. MMPs price by conversions; Mocco can bundle links into the platform plan with a clicks quota.
4. **Release-aware routing.** Mocco knows which app builds and OTA bundles are in production (#99). A link can
   declare "requires build >= X"; users on older builds get "update the app" instead of a crash or dead screen. No
   competitor has this data.
5. **Governance of link infrastructure.** Changing AASA/assetlinks or a link domain can silently break every
   universal link; Mocco can put those changes through gates and the hash-chained audit log.
6. **Korean in-app browsers.** KakaoTalk, Naver and Instagram in-app webviews often do not trigger Universal
   Links; a landing page that detects them and offers an explicit "Open in app" / external-browser escape plus
   Kakao-friendly OG tags (`kakaotalk-scrap` crawler) is a local differentiator (Kakao behaviour unverified in this
   session; must be tested on devices).
7. **Abuse controls as a feature.** Destination allowlists (verified domains), Web Risk checks, and per-project
   kill switches — shorteners are phishing vectors and MMPs rarely expose these controls to developers.

## Recommended positioning and v1 feature set

**Positioning:** "Firebase Dynamic Links, done right and yours to keep" — developer-first smart links on your own
domain, deterministic deferred deep linking, an RN SDK and API, abuse-safe by default, self-hostable, and aware of
what is running in production. Explicitly not an MMP.

**Table stakes**
- Short links on a custom domain (plus a Mocco-provided default subdomain), custom slugs, runtime link-creation API.
- AASA and assetlinks hosting, generated from the project's registered apps (team ID, bundle ID, package name,
  SHA-256 fingerprints), including Android 15 dynamic rules.
- Platform routing with App Store / Play Store / web fallbacks; UTM passthrough.
- Android deferred deep linking via Play Install Referrer.
- iOS deferred via landing page with clipboard handoff (explicit user action).
- OG previews with crawler detection; QR codes (SVG/PNG).
- Click, open, first-open analytics per link and campaign; platform split.
- React Native SDK (`getInitialLink`, `onLink`, `resolveDeferred`, `createLink`).

**Differentiators**
- Release-aware routing (`minBuild`) using Mocco's release data.
- Governed, audited changes to link domains and association files.
- Destination allowlist of verified domains + Web Risk checks + kill switch.
- Self-host parity: one Postgres, no mandatory analytics vendor.
- In-app browser (KakaoTalk, Instagram, Naver, Facebook) detection with escape UX.
- Link payloads usable by other Mocco products (feature flag context #101, messenger/help-center share links).

**Deliberately skip (v1)**
- Paid-ad attribution, SKAdNetwork/AdAttributionKit, MMP postbacks, ad-network integrations.
- IP/UA probabilistic matching on iOS (revisit only as an explicit, off-by-default Android-only fallback).
- Link-level A/B destinations, smart banners/journeys, email-client (ESP) click-tracking integrations.
- Opening third-party apps (URLgenius-style).
- Native iOS/Android/Flutter SDKs (RN first; plain REST documented for others).

## Sources

1. https://firebase.google.com/support/dynamic-links-faq
2. https://developer.apple.com/app-store/user-privacy-and-data-use/
3. https://www.appsflyer.com/blog/measurement-analytics/firebase-migration/
4. https://www.appsflyer.com/pricing/
5. https://appy.to/blog/appsflyer-free-plan-alternative
6. https://www.branch.io/pricing/
7. https://chottulink.com/blog/branch-io-pricing-what-it-actually-costs-and-what-drives-the-quote/
8. https://linklyhq.com/review/branch
9. https://help.branch.io/docs/complying-with-apples-policy-faq
10. https://en.wowtale.net/2026/07/04/234385/
11. https://www.airbridge.io/en/pricing
12. https://www.airbridge.io/en/deeplink-plan
13. https://www.airbridge.io/blog/enterprise-budget-for-deep-linking
14. https://chottulink.com/blog/airbridge-deeplink-vs-chottulink-which-deep-linking-solution-is-better-in-2025/
15. https://www.airbridge.io/en/blog/deferred-deeplink-post-idfa-accuracy
16. https://dub.co/docs/concepts/deep-links/quickstart
17. https://dub.co/pricing
18. https://linklyhq.com/review/dub
19. https://dub.co/docs/concepts/deep-links/deferred-deep-linking
20. https://chottulink.com/blog/firebase-dynamic-links-shut-down-5-best-alternatives-for-2026/
21. https://chottulink.com/pricing.html
22. https://www.adjust.com/pricing
23. https://www.kochava.com/product/free-app-analytics/
24. https://costbench.com/software/marketing-attribution/singular-attribution/
25. https://u2l.ai/blog/bitly-pricing-breakdown
26. https://short.io/pricing
27. https://linklyhq.com/blog/rebrandly-pricing
28. https://app.urlgeni.us/pricing
29. https://linkrunner.io/deeplinks
30. https://linkrunner.io/blog/best-8-deep-linking-tools-for-mobile-apps-in-2026
31. https://flinku.dev/blog/branch-io-alternatives-indie-developers/
32. https://developer.android.com/training/app-links/configure-assetlinks
33. https://developer.android.com/google/play/installreferrer/library
34. https://cloud.google.com/web-risk/pricing
35. https://www.airbridge.io/en/blog/firebase-dynamic-links-alternatives
