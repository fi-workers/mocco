---
title: App-store review analysis — competitor research
description: Competitive landscape for app-store review ingestion and AI analysis (AppFollow, Appbot, AppTweak, Sensor Tower, feedback-intelligence platforms, Slack bots) and where Mocco's release awareness gives it a defensible wedge.
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, app-reviews]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-app-reviews-design.md
---

# App-store review analysis — competitor research

## Summary

Review analysis is a crowded, mature category, and AI tagging is no longer a differentiator on its own. The dedicated review tools (AppFollow, Appbot) have made LLM sentiment, topic tagging, translation and AI auto-replies standard, at roughly $50–$600/month priced by number of apps. ASO suites (AppTweak, MobileAction, Sensor Tower) fold reviews into keyword and market intelligence and add "ask your reviews" agents. Feedback-intelligence platforms (Unwrap, Enterpret) treat app reviews as one of 50+ channels, sell six-figure enterprise contracts and focus on revenue impact. None of these tools knows what was deployed. At best they show the store's version string next to a review, and they draw release markers from store metadata, not from the team's own pipeline. Mocco already records runs, gates, approvers and credentials for each production release. It can say "1–2 star share tripled within 18 hours of run #412 promoting 2.3.1, approved by X", and link that to the commit range and to a rollback gate. That release-correlation wedge, bundled free or cheap inside a workspace the team already uses, is the positioning. Mocco should skip everything ASO-related (keywords, competitor tracking, market estimates) and ship replies only in v2, behind an approval gate.

## Market map

| Segment | Players | What they sell | Typical price |
|---|---|---|---|
| Dedicated review management | AppFollow, Appbot, Reply Argus (unverified), App Review Bot-style tools | Aggregation, AI tags/sentiment, replies/auto-replies, helpdesk sync | $50–$600/mo |
| ASO / app intelligence suites with a reviews module | AppTweak, MobileAction, Sensor Tower (+ data.ai), Similarweb apps | Keywords, market estimates, ads intelligence; reviews as one tab plus AI agents | $79–$833/mo self-serve; Sensor Tower $30k–$300k/yr |
| Omnichannel feedback intelligence | Unwrap.ai, Enterpret (also Idiomatic, Productboard Pulse — unverified) | Cross-channel theme clustering, knowledge graph, revenue weighting, agents | Enterprise, sales-led (unverified; typically five-to-six figures/yr) |
| In-app feedback and rating prompts | Alchemer Mobile (ex-Apptentive), Luciq (ex-Instabug) App Ratings & Reviews | SDK-driven prompts to lift rating, plus store review monitoring tied to sessions and crashes | Sales-led |
| Slack notifiers | ReviewBot (reviewbot.io), AppReviewBot, AppFollow/Appbot Slack integrations | Post each review to Slack; reply from Slack | $5–$10/mo |
| Local-business reputation | Birdeye (also Podium, Yext) | Google Business/Yelp reviews for multi-location businesses; app stores not core | $299+/mo |
| Korean market | No dedicated Korean review SaaS found; AppTweak and AppFollow sell localized Korean sites; OSS pipelines (e.g. `alstjd8826/app-review-pipeline`) | — | — |

## Competitor profiles

### AppFollow (deep)

- **What:** Review management plus ASO platform; claims 100,000+ product teams (https://appfollow.io/pricing).
- **Target:** Support and CX teams at consumer app publishers and games; also ASO managers.
- **Key features:** Unified inbox for App Store, Google Play and other stores (Team plan adds Microsoft, Xbox, Amazon); AI replies and auto-replies; automated review translation; sentiment and semantic tags; word cloud; advanced alerts; agent performance reports; helpdesk integrations (Zendesk and others); Slack integration for review alerts and replying (https://appfollow.io/slack); CSV/Excel export.
- **Pricing (2026):** Free tier for basic aggregation (unverified detail: up to 2 apps). Essential $179/mo monthly or $129/mo yearly, 5 apps, 365 days of history. Team $599/mo or $425/mo yearly, 15 apps, full history. Enterprise custom. ASO-only plan from $19/mo yearly. Unlimited users on every plan; the price scales by app count and features. 10-day trial. Sources: https://www.softwaresuggest.com/appfollow, https://appfollow.io/blog/new-plans-at-appfollow-and-how-to-choose-the-right-one, https://www.g2.com/products/appfollow/pricing. Third-party listings disagree (some show $99 Growth and $249 Pro tiers at https://saaspartout.com/marketplace/appfollow/), so the tier names are (unverified).
- **Platforms:** Web app; Slack, Zendesk, Salesforce/Helpshift-style helpdesk sync (unverified list); public API on higher tiers (unverified).
- **Open source / self-host:** No.
- **Strengths:** The most complete reply workflow (auto-reply rules, AI drafts, agent metrics). Broad store coverage. Unlimited seats.
- **Weaknesses:** Priced by app count, so a studio with many small apps pays a lot. Analytics centre on the support inbox, not on engineering. Release markers come from store metadata only. Nothing links a review to a CI run or commit.
- **Recent news:** Plans were restructured into Essential/Team/Enterprise with an ASO add-on (see blog above). No acquisition found for 2025–2026 (searches returned nothing).

### Appbot (deep)

- **What:** Review and rating analysis for mobile teams. Claims analysis trained on 400M+ reviews, 93%+ sentiment accuracy, and use by 25% of the Fortune 100 (https://appbot.co/).
- **Target:** Product and insights teams that want analysis more than a reply inbox.
- **Key features:** Sentiment, automatic topics (bugs, UI, performance, onboarding, pricing), custom dashboards, Slack/Teams notifications, reply links to the store, replying in the console or through integrations on Large and above, unlimited auto-replies, "Ask Appbot" natural-language Q&A, and **MCP access** so AI assistants can query the review data (https://appbot.co/plans/).
- **Pricing (2026, https://appbot.co/plans/):** Small $59/mo ($49/mo annual), 1 user, 5 sources. Medium $119/mo ($99/mo annual), 3 users, 40 sources. Large from $219/mo ($166/mo annual), 7+ users, 100+ sources, with export, replies, Ask Appbot and MCP. Premium from $479/mo, annual only, 20+ users, with SSO. API is an add-on on Large/Premium. 14-day trial, no card.
- **Platforms:** Web, Slack, Teams, MCP; API add-on.
- **Open source / self-host:** No.
- **Strengths:** Transparent, cheap entry price. Strong analysis focus. Early MCP support.
- **Weaknesses:** Seat-limited tiers. API costs extra. No link to deploys. Version analysis is only as good as the store's version metadata, which Apple does not provide (see the design doc).
- **Recent news:** Added the Ask Appbot and MCP surfaces (plans page; launch date unverified).

### AppTweak (deep)

- **What:** ASO and app-intelligence suite (Brussels, founded 2014), with a reviews tool (https://www.apptweak.com/en/app-reviews-tool).
- **Target:** ASO and mobile marketing teams at mid-to-large publishers.
- **Key features:** Monitor, analyze and reply to App Store and Google Play reviews across apps, countries and languages. Review analysis surfaces feature requests and complaint themes. The **Reviews Agent** answers natural-language questions about reviews and returns prioritized action points (https://help.apptweak.com/en/articles/13844333-reviews-agent). It launched with ASO Agent and Reporting Agent after Ad Agent (Nov 2025) (https://www.prnewswire.com/news-releases/apptweak-launches-ai-agents-to-scale-aso-and-apple-ads-performance-302704511.html). ISO 27001, and customer data is not used for training.
- **Pricing (Aug 2026):** Essential $79/mo, Grow $299/mo, Grow Plus $549/mo, Enterprise by quote (https://www.strataigize.com/insights/apptweak-overview-features-pricing-and-plans/).
- **Platforms:** Web, API (paid credits, unverified), Korean-localized site (https://www.apptweak.com/ko/app-reviews-tool).
- **Open source / self-host:** No.
- **Strengths:** Grounded in store intelligence and competitor data. Agents. Enterprise security posture.
- **Weaknesses:** Reviews are secondary to ASO. Expensive for engineering-only buyers. No link to deploys.
- **Recent news:** AI agent rollout, 2025–2026 (above); 2025 product recap at https://www.apptweak.com/en/aso-blog/year-in-review-apptweaks-2025-product-highlights.

### Sensor Tower (incl. data.ai) (deep)

- **What:** The dominant app market-intelligence vendor. It acquired data.ai (formerly App Annie) on 2024-03-18 (https://sensortower.com/blog/data-ai-joins-sensor-tower, https://techcrunch.com/2024/03/18/app-analytics-firm-sensor-tower-acquires-rival-data-ai/). Through 2025 it merged the two datasets (App Overlap, install base, retention, 20 new countries) (https://sensortower.com/blog/platform-updates-summer-2025).
- **Target:** Publishers, advertisers and investors buying market data.
- **Key features:** Download and revenue estimates, ad intelligence, usage and retention panels, and review and rating analysis for any app, including competitors. In 2026 it expanded into web insights.
- **Pricing:** Sales-led, annual contracts. Entry around $500/mo single-module (unverified). Vendr bands: $30k–$70k/yr for small teams, $70k–$150k mid-market, $150k–$300k+ enterprise (https://www.vendr.com/marketplace/sensor-tower).
- **Open source / self-host:** No.
- **Strengths:** Competitor reviews and ratings at market scale. Historical depth from the merger.
- **Weaknesses:** Price. Built for market analysis, not for an engineering loop. No private deploy context. Offers no reply workflow (unverified).
- **Recent news:** The data.ai integration finished through 2025. The merger left one near-monopoly for app intelligence (https://www.strataigize.com/insights/data-ai-app-annie-features-pricing-use-cases/).

### Luciq (formerly Instabug) (deep)

- **What:** Mobile observability (crash reporting, APM, session replay, bug reporting). Rebranded to Luciq.ai on 2025-09-24 as "agentic mobile observability" (https://www.businesswire.com/news/home/20250924435921/en/Instabug-Becomes-Luciq.ai-Pioneers-New-Category-Agentic-Mobile-Observability).
- **Target:** Mobile engineering teams.
- **Key features (App Ratings & Reviews):** Fetches existing and new store reviews after bundle-id confirmation. Monitors store performance per release. Rating over time and per country. Links in-app rating prompts to Session Replay so the team sees what led to a rating. Requires iOS SDK 12.0+ / Android SDK 12.1.0+ (https://docs.luciq.ai/product-guides-and-integrations/product-guides/app-ratings-and-reviews, https://docs.luciq.ai/docs/ios-app-reviews). Also has feature flags, rollout management and "Release" agents (https://github.com/api-evangelist/instabug).
- **Pricing:** Sales-led (unverified public tiers).
- **Open source / self-host:** No (SDKs are open, the backend is not).
- **Strengths:** The closest to Mocco's angle. Reviews sit next to crashes and releases, and it has rollout management.
- **Weaknesses:** Requires its SDK inside the app. Its "release" is the SDK-reported app version, not a governed deploy or approval record. It is a heavyweight observability purchase.
- **Recent news:** Luciq rebrand and AI agents (Detect, Resolve, Release), Sept 2025.

### Unwrap.ai

- **What:** AI customer-intelligence platform that clusters feedback from many channels (support tickets, surveys, app reviews, social) into themes.
- **Target:** Product and CX teams at larger companies (Microsoft, Oura, Lyft, Perplexity are listed customers).
- **Pricing:** Sales-led, not public (unverified).
- **Funding/news:** $12M Series A on 2025-01-30 led by Scale Venture Partners with Atlassian Ventures participating; it has not been acquired (https://www.businesswire.com/news/home/20250130865543/en/AI-powered-Analytics-Platform-Unwrap-Secures-Series-A-to-Redefine-Customer-Intelligence).
- **Strengths/weaknesses:** Good cross-channel clustering. App stores are one source among many. No deploy context. Too expensive for small teams.

### Enterpret

- **What:** "Customer intelligence" with an adaptive taxonomy and a customer knowledge graph over 50+ feedback channels. Added agents in Oct 2025 that detect and act on issues in real time (https://siliconangle.com/2025/10/27/exclusive-enterpret-adds-agents-customer-feedback-analysis-platform/).
- **Funding:** $20.8M Series A, Dec 2024, led by Canaan; seven-figure ARR (https://www.enterpret.com/blog/enterpret-series-a).
- **Pricing:** Sales-led; see https://www.vendr.com/marketplace/enterpret (figures unverified).
- **Relevance:** Sets the bar for adaptive taxonomy, meaning topics that evolve instead of a fixed list, and for revenue weighting. Enterprise-only.

### MobileAction

- **What:** ASO and Apple Search Ads intelligence with review management and sentiment analysis (https://www.capterra.com/p/200378/MobileAction/).
- **Pricing (2026):** Lite from $15/mo; ASO Basic $59/mo; ASO Pro $199/mo; Market Intelligence Pro $833/mo; Enterprise. 7-day trial (https://www.getapp.com/all-software/a/mobileaction/).
- **Relevance:** Reviews are a checkbox inside an ads and ASO product.

### Alchemer Mobile (formerly Apptentive)

- **What:** In-app feedback SDK (prompts, surveys, rating requests). Alchemer acquired Apptentive in Jan 2023 (https://www.alchemer.com/resources/blog/alchemer-acquires-apptentive-market-leading-mobile-feedback-platform/). The May 2026 "Alchemer Digital" release added recurring prompts, multi-target interactions and a faster SDK (https://www.businesswire.com/news/home/20260506713270/en/Alchemer-Expands-Digital-Capabilities-to-Help-Organizations-Capture-and-Act-on-In-App-Feedback).
- **Pricing:** Sales-led (not public).
- **Relevance:** Different lever (raising ratings by prompting happy users). Mocco should not build prompt SDKs in v1.

### ReviewBot and AppReviewBot (Slack notifiers)

- **ReviewBot** (https://reviewbot.io/): posts App Store and Google Play reviews into Slack or Zendesk and lets you reply from Slack. From about $5 per active flow/month annual, about $10/month (https://slack.com/apps/A0VN4GMBL-reviewbot).
- **AppReviewBot** (https://www.appreviewbot.com/): posts reviews to Slack, unlimited apps and countries, deep links to reply in the consoles. From $5.99/mo.
- **Relevance:** Sets the price floor for "reviews in Slack". Teams will not pay much for raw notification. The value has to be in analysis and correlation.

### Birdeye

- **What:** Reputation management for multi-location local businesses (Google Business Profile, Facebook, Yelp). $299–$349/mo plus fees and annual contracts (https://wiserreview.com/blog/birdeye-pricing/). App-store reviews are not core (https://reviewhook.dev/blog/birdeye-pricing-2026).
- **Relevance:** Adjacent only. Listed because it shows up in "review management" searches.

### Similarweb (apps ratings and reviews)

- Offers app ratings and review analysis as part of its digital-intelligence suite (https://www.similarweb.com/corp/apps/ratings-reviews/). Enterprise pricing (unverified). Relevant as another market-intelligence incumbent.

### Korean market

- No Korean-native SaaS dedicated to app-review analysis turned up. Korean teams buy AppTweak or AppFollow, both of which have localized sites, or build internal pipelines. A public example is `alstjd8826/app-review-pipeline` (collect → normalize → AI classify → draft → 3-stage guardrail → Slack review → publish; https://github.com/alstjd8826/app-review-pipeline). A Wishket case study describes an internal AI review-analysis build that lifted a rating from 3.8 to 4.5 (https://blog.wishket.com/blog/46167).
- Korean-specific stores: ONE store and Samsung Galaxy Store. None of the tools above covers ONE store (unverified). This is a possible later differentiator for Korean customers, but it is out of scope for v1.
- Korean-language quality matters. LLM classification handles Korean well. Keyword and word-cloud tools that split on spaces handle it badly.

## Feature matrix

Legend: Y = yes, P = partial or add-on, N = no, ? = unverified.

| Capability | AppFollow | Appbot | AppTweak | Sensor Tower | Luciq | Unwrap | Enterpret | MobileAction | ReviewBot | Mocco v1 (proposed) |
|---|---|---|---|---|---|---|---|---|---|---|
| App Store + Google Play ingest | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Other stores (Amazon, MS, Huawei, ONE store) | P (Team) | P | ? | P | N | ? | ? | ? | N | N |
| AI sentiment | Y | Y | Y | Y | ? | Y | Y | Y | N | Y |
| Topic tagging | Y (semantic tags) | Y | Y | Y | ? | Y (clusters) | Y (adaptive) | Y | N | Y (taxonomy + suggested) |
| Auto-translation | Y | ? | ? | ? | ? | Y | Y | ? | N | Y |
| Bug-report flag | P | P (bug topic) | P | N | Y (links to crashes) | P | P | N | N | Y |
| Natural-language Q&A / agent | Y (AI) | Y (Ask Appbot, MCP) | Y (Reviews Agent) | ? | Y (agents) | Y | Y (agents) | ? | N | N (v2: MCP) |
| Reply / auto-reply | Y | Y (Large+) | Y | N | ? | N | N | P | Y | N (v2, gated) |
| Slack alerts | Y | Y | ? | ? | ? | Y | Y | ? | Y | Y |
| Digest reports | Y | Y | Y (Reporting Agent) | Y | ? | Y | Y | Y | N | Y |
| Rating by app version | P (store metadata) | P | P | P | Y (SDK version) | N | N | P | N | Y (Play exact, Apple inferred) |
| Correlation with CI/CD deploys and approvals | N | N | N | N | P (SDK release, rollout mgmt) | N | N | N | N | **Y** |
| Staged-rollout awareness | N | N | N | N | P | N | N | N | N | Y (Play track fraction) |
| Competitor apps | P | Y | Y | Y | N | N | N | Y | N | N (skip) |
| Public API | P | P (add-on) | Y | Y | Y | ? | ? | Y | N | P (v1 release-marker API only) |
| Self-host / open source | N | N | N | N | N | N | N | N | N | **Y (AGPL)** |

## Pricing comparison

| Product | Entry | Mid | Top self-serve | Enterprise | Pricing unit |
|---|---|---|---|---|---|
| AppFollow | Free (limited); Essential $179/mo ($129 yearly) | Team $599/mo ($425 yearly) | — | Custom | Apps + features; unlimited users |
| Appbot | Small $59/mo ($49 annual) | Medium $119/mo ($99) | Large from $219/mo ($166) | Premium from $479/mo | Sources + users |
| AppTweak | Essential $79/mo | Grow $299/mo | Grow Plus $549/mo | Quote | Apps/keywords/features |
| MobileAction | Lite $15/mo; ASO Basic $59/mo | ASO Pro $199/mo | MI Pro $833/mo | Quote | Module |
| Sensor Tower | ~ $500/mo single module (unverified) | $30k–$70k/yr | $70k–$150k/yr | $150k–$300k+/yr | Seats + modules + geos |
| Unwrap / Enterpret | — | — | — | Sales-led (unverified) | Volume / channels |
| ReviewBot | ~$5–$10/mo | — | — | — | Flows |
| AppReviewBot | $5.99/mo | — | — | — | Flat |
| Birdeye | $299/mo | $349/mo | — | Quote | Locations |

## Gaps and opportunities for Mocco

1. **No competitor ties a review wave to the deploy that caused it.** They show "version 2.3.1" at best. Mocco can name the run, the commit range, the approvers and the gate, and offer a one-click "open a rollback/hotfix run" link.
2. **Apple's API has no app version on reviews.** Every competitor either scrapes the public RSS feed (which includes a version, for the latest ~500 reviews per country) or guesses. Mocco has the exact production release timestamp per app from its own runs, so it can infer "which version was live in this territory when this review was written" more accurately than anyone using store metadata alone. The inference still has to be marked as inferred.
3. **Staged rollouts.** Google Play releases roll out by user fraction. Correlating reviews with rollout percentage, and pausing a rollout through a Mocco gate when a spike hits, is unique. That second half is a v2 hook into the OTA and flags products.
4. **Price floor is low and analysis is commoditized**, so reviews should be a bundled module of the Mocco workspace (metered by apps and analyzed reviews), not a standalone $179/mo product.
5. **Self-hosted, AGPL, bring-your-own-LLM-key.** No incumbent offers self-hosting. Regulated teams (fintech, health; the team's own context at Algocare) that cannot send user reviews plus store credentials to another SaaS have no option today.
6. **Korean coverage:** Korean-first UX, good Korean classification, and later ONE store support. The incumbents are English-first.
7. **Engineering-first loop:** clustered bug reports feed the feedback board (#98) and GitHub issues. Incumbents are CX-inbox-first.

## Recommended positioning and v1 feature set

**Positioning:** "Know which deploy moved your rating." App-store reviews, analyzed and lined up against the production releases Mocco already governs. Included in the Mocco workspace, self-hostable, bring your own LLM key.

### Table stakes (must ship in v1)

- App Store Connect and Google Play connections with encrypted credentials and a connection test.
- Scheduled, idempotent ingestion. Play polled at least daily (7-day window), with a freshness alarm.
- Reviews list with filters in the URL (store, version, rating, topic, language, territory, sentiment, bug flag).
- Per-review LLM analysis: sentiment, topics from a workspace taxonomy, bug-report flag, language detection and English translation.
- Rating and topic trends per version; daily or weekly digest; Slack alerts, with email second.

### Differentiators

- **Release timeline from Mocco runs.** A release marker is created by the run that promoted the build. Each review is tagged with an exact (Play) or inferred (Apple) version and linked to its run.
- **Before/after deltas per release** with sample-size guards (Wilson interval), and spike alerts that name the run, the approvers and the commit range.
- **Play staged-rollout fraction** on the timeline.
- **New-topic detection** ("topic X appeared after 2.3.1"), not only fixed tags.
- **Self-host plus BYO LLM**, cost metered per analyzed review and visible to the workspace.

### Deliberately skip (v1)

- Replies and auto-replies. v2, behind a lightweight approval gate, which reuses Mocco's own gate concept.
- ASO: keywords, competitor apps, market estimates, ad intelligence.
- In-app rating prompt SDKs.
- Stores other than App Store and Google Play (ONE store, Galaxy, Amazon, Huawei).
- Social mentions and helpdesk ingestion (the Unwrap/Enterpret territory).
- Natural-language "ask your reviews" chat. v2, exposed through MCP like Appbot's.
- Auto-filing GitHub issues. Follow-up, via the feedback board (#98).

## Sources

- https://appfollow.io/pricing
- https://appfollow.io/blog/new-plans-at-appfollow-and-how-to-choose-the-right-one
- https://appfollow.io/blog/appstore-review-management-software
- https://appfollow.io/slack
- https://www.softwaresuggest.com/appfollow
- https://www.g2.com/products/appfollow/pricing
- https://saaspartout.com/marketplace/appfollow/
- https://appbot.co/
- https://appbot.co/plans/
- https://www.apptweak.com/en/app-reviews-tool
- https://www.apptweak.com/ko/app-reviews-tool
- https://help.apptweak.com/en/articles/13844333-reviews-agent
- https://www.prnewswire.com/news-releases/apptweak-launches-ai-agents-to-scale-aso-and-apple-ads-performance-302704511.html
- https://www.apptweak.com/en/aso-blog/year-in-review-apptweaks-2025-product-highlights
- https://www.strataigize.com/insights/apptweak-overview-features-pricing-and-plans/
- https://sensortower.com/blog/data-ai-joins-sensor-tower
- https://techcrunch.com/2024/03/18/app-analytics-firm-sensor-tower-acquires-rival-data-ai/
- https://sensortower.com/blog/platform-updates-summer-2025
- https://www.vendr.com/marketplace/sensor-tower
- https://www.strataigize.com/insights/data-ai-app-annie-features-pricing-use-cases/
- https://www.businesswire.com/news/home/20250924435921/en/Instabug-Becomes-Luciq.ai-Pioneers-New-Category-Agentic-Mobile-Observability
- https://docs.luciq.ai/product-guides-and-integrations/product-guides/app-ratings-and-reviews
- https://docs.luciq.ai/docs/ios-app-reviews
- https://github.com/api-evangelist/instabug
- https://www.businesswire.com/news/home/20250130865543/en/AI-powered-Analytics-Platform-Unwrap-Secures-Series-A-to-Redefine-Customer-Intelligence
- https://www.unwrap.ai/
- https://siliconangle.com/2025/10/27/exclusive-enterpret-adds-agents-customer-feedback-analysis-platform/
- https://www.enterpret.com/blog/enterpret-series-a
- https://www.vendr.com/marketplace/enterpret
- https://www.capterra.com/p/200378/MobileAction/
- https://www.getapp.com/all-software/a/mobileaction/
- https://www.alchemer.com/resources/blog/alchemer-acquires-apptentive-market-leading-mobile-feedback-platform/
- https://www.businesswire.com/news/home/20260506713270/en/Alchemer-Expands-Digital-Capabilities-to-Help-Organizations-Capture-and-Act-on-In-App-Feedback
- https://reviewbot.io/
- https://slack.com/apps/A0VN4GMBL-reviewbot
- https://www.appreviewbot.com/
- https://wiserreview.com/blog/birdeye-pricing/
- https://reviewhook.dev/blog/birdeye-pricing-2026
- https://www.similarweb.com/corp/apps/ratings-reviews/
- https://github.com/alstjd8826/app-review-pipeline
- https://blog.wishket.com/blog/46167
- https://developers.google.com/android-publisher/reply-to-reviews
- https://developers.google.com/android-publisher/quotas
- https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews
- https://developer.apple.com/forums/thread/817212
- https://www.runway.team/blog/guide-to-the-app-store-connect-api-calculate-your-ios-app-rating
