---
title: All-in-one developer platforms — competitor research
description: How PostHog, Firebase, Supabase, Expo, Vercel, Sentry, support suites, DevOps suites and Korean all-in-ones bundle many products, and what Mocco should copy or avoid when sequencing, pricing and packaging its 11 product lines.
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, platform]
related:
  - ../reference/roadmap.md
---

# All-in-one developer platforms — competitor research

## Summary

No platform covers more than four or five of Mocco's eleven planned product lines. The multi-product
companies group into three clusters that each serve one buyer: release engineering (Vercel, Expo, GitLab,
Firebase), product and growth (PostHog, Hackle, Featurebase) and support (Intercom, Zendesk, Channel Talk).
Mocco's lineup spans all three. That makes it wider than anyone else, and also more likely than anyone
else to feel like "ten mediocre tools".

PostHog is the model to study. It runs each product as a "micro SaaS" with its own 4–6 person team, roadmap
and price. Every product shares one data spine (events and persons), gets a separate monthly free tier, and
is billed per unit of usage. Organization features (SSO, RBAC, audit logs, SLAs) are sold separately as
platform packages ($250 and $750/month). PostHog ships alpha and beta for free, adds pricing at general
availability (GA), and only enters markets that already have $1B+ competitors. That playbook took it to an
estimated $57.5M ARR (Feb 2026) and a $1.4B valuation.

Firebase shows the other side of bundling. Free loss-leader products (Crashlytics, App Distribution, FCM)
feed the paid Blaze plan, but Google retires products that earn nothing: Dynamic Links (Aug 2025), Firebase
Studio (2027), Extensions (2027). Atlassian's Opsgenie (Apr 2027) and Microsoft's App Center/CodePush
(Mar 2025) were retired the same way. Each shutdown freed up a migration market. OTA (the CodePush vacuum)
and deep links (the Dynamic Links vacuum) are two of Mocco's planned lines.

For Mocco, lock-in should come from its shared spine rather than from bundling discounts. That spine is the
deploy/release event stream plus end-user identity. Each product should also be sellable, and priced, on its
own.

## Market map

| Segment | Players | Shared spine that makes the bundle work |
|---|---|---|
| Product-engineering suite | PostHog, Hackle (KR), Amplitude, Statsig (acquired by OpenAI, unverified) | Event stream and person profiles |
| Mobile/app backend-as-a-service | Firebase, Supabase, Appwrite | Project + end-user auth + SDK |
| Release/build platform | Expo EAS, Vercel, GitLab, Atlassian (Bitbucket/Compass), Codemagic | Build/deploy artifacts and environments |
| Observability suite | Sentry, Better Stack, Datadog | Telemetry (errors, spans, logs, monitors) |
| Customer support suite | Intercom, Zendesk, Channel Talk (KR), Featurebase | End-user/contact identity and conversation inbox |
| Product feedback suite (2024–2026 entrants) | Featurebase, Userorbit, Canny | Feedback + roadmap + changelog + help center |
| Point tools in Mocco's lines | Airbridge (KR), Branch, AppsFlyer (links); Statuspage, instatus (status); Clerk, Auth0 (identity) | n/a |

Mocco's proposed spine is "what reached production, when, and who approved it" plus one workspace and one
end-user identity. No competitor spans release events and support/feedback data together.

## Platform profiles

### PostHog (deep dive)

**What it is.** It calls itself "every piece of SaaS that a product engineer needs"
([Product Hunt](https://www.producthunt.com/products/posthog)). It is built for engineers, not PMs or marketers.

**Products and sequencing.** PostHog launched product analytics in 2020. It then added session replay
(first bundled, later a separately priced product), feature flags, experiments, surveys, a CDP/data pipelines
product (60+ destinations by Sep 2025), a data warehouse, web analytics, error tracking, LLM/AI
observability, PostHog AI, Workflows (messaging), Logs, Replay Vision, an "Inbox" that opens PRs (beta), and
PostHog Desktop (Aug 26, 2026)
([Contrary](https://research.contrary.com/company/posthog), [pricing](https://posthog.com/pricing),
[Mean CEO Sep 2026](https://blog.mean.ceo/posthog-news-september-2026/)). Exact launch dates for most
products were not verified.

**How they pick and sequence products:**
- They build only in markets with proven demand and $1B+ incumbents, and only after repeated customer
  requests. Replay and flags came after "many people asking for it"
  ([How They Grow](https://www.howtheygrow.co/p/how-posthog-grows-the-power-of-being)).
- The stated ambition is to "build 300 products instead of 30" and keep "our moat of being the widest"
  ([multi-product pricing](https://posthog.com/blog/multi-product-pricing)).
- Each product runs as a mini-startup with an autonomous 4–6 person team, its own roadmap, changelog and
  pricing (How They Grow).
- Every new product reuses the same person/event model and SDK. Flags, replay, surveys and errors all attach
  to the same `distinct_id`, which is why cross-sell is cheap.
- Release stages are concept (waitlist), alpha (invite only), beta (opt-in for everyone) and GA. Alpha and
  beta are free and pricing ships at GA. AI products are the exception and get priced earlier because of
  inference cost ([handbook](https://posthog.com/handbook/product/releasing-new-products-and-features)).
  The team lead decides launch readiness, and marketing gets at least two weeks' notice.

**Pricing model.** Each product has its own usage meter and its own free allowance, which renews monthly
"for everything … forever" ([pricing](https://posthog.com/pricing)):

| Product | Free / month | First paid unit |
|---|---|---|
| Product analytics | 1M events | ~$0.00005/event |
| Session replay | 5K recordings | $0.005/recording, falling to $0.0015 at 500K+ |
| Feature flags | 1M requests | $0.0001/request, falling to $0.00001 at 50M+ |
| Error tracking | 100K exceptions | usage |
| Surveys | 1,500 responses | ~$0.20/response |
| Data warehouse | 1M rows | usage |
| Workflows | 10K messages/channel | usage |
| Logs | 10 GB | usage |
| AI observability | 100K events | usage |

Sources: [pricing](https://posthog.com/pricing), [Flexprice](https://flexprice.io/blog/posthog-pricing-guide),
[Contrary](https://research.contrary.com/company/posthog).

Org-level features are sold separately as
[platform packages](https://posthog.com/platform-packages). Boost ($250/mo) adds unlimited projects, SSO
enforcement, white labelling and a HIPAA BAA. Scale ($750/mo) adds SAML, priority support and two months of
activity logs. Enterprise (custom) adds RBAC, SCIM and 60-month audit logs. PostHog says "97% of companies
use PostHog for free." Customers can set a billing limit per product.

**Why per-product pricing, with no bundle discount.** Charging for replay made users treat it as a real
product: it reached "similar daily usage to product analytics", and a newly launched product made up 10% of
revenue within about three months. Small teams can own their own pricing. Selling products separately lets
PostHog "out compete all of your competitors on price." The cost is a complicated billing system
([multi-product pricing](https://posthog.com/blog/multi-product-pricing)).

**OSS / self-host.** The core repo is MIT and can be self-hosted as a single-machine Docker Compose
"hobby" deploy with no support, scaling to "a couple 100ks events" at most. Kubernetes/Helm support was
sunset, and paid self-host licences are no longer sold. Several products (experiments, surveys, advanced
flags) are cloud-only ([self-host docs](https://posthog.com/docs/self-host),
[disclaimer](https://posthog.com/docs/self-host/open-source/disclaimer),
[Helm sunset](https://posthog.com/blog/sunsetting-helm-support-posthog)).

**Scale.** Sacra estimates $57.5M ARR in Feb 2026, about 2x year over year. Contrary's older figure of $9.5M
conflicts with this and is probably stale. PostHog raised a $75M Series E at $1.4B in Oct 2025 and reports
108K+ installations and a median 3x spend expansion within 18 months
([Sacra](https://sacra.com/c/posthog/),
[SaaS News](https://www.thesaasnews.com/news/posthog-raises-75m-series-e-at-1-4b-valuation/),
[Contrary](https://research.contrary.com/company/posthog)).

**What worked:** one SDK and one data model, generous per-product free tiers, transparent public pricing,
developer-first content, and no sales-led discounting.

**What failed or was abandoned:** paid self-host, a scalable open-source deploy (Helm), and bundled free
replay (which was undervalued until PostHog charged for it).

### Firebase (Google)

**Products.** Authentication, Firestore/RTDB, Data Connect (SQL Connect), Hosting and App Hosting, Cloud
Functions, Storage, Crashlytics, Performance Monitoring, Remote Config, A/B Testing, App Distribution, Cloud
Messaging, In-App Messaging, App Check and Analytics.

**Pricing.** There are two plans: Spark (free) and Blaze (pay as you go). A/B Testing, Analytics, App Check,
App Distribution, FCM, Crashlytics, In-App Messaging and Performance Monitoring cost nothing on either plan.
Auth includes 50K MAU, with phone/SMS billed per message and Identity Platform pricing above that. The
pricing page shows Remote Config free up to 100K daily requests, then $0.000006/request
([pricing](https://firebase.google.com/pricing)). The zero-cost observability and distribution products
are the funnel into paid database, hosting and auth usage.

**Shutdowns.** Dynamic Links shut down on Aug 25, 2025, and every `page.link` and custom-domain link stopped
working. Google pointed customers to Adjust, Airbridge, AppsFlyer, Branch, Kochava and Singular
([FAQ](https://firebase.google.com/support/dynamic-links-faq)). Also announced (via
[Releasebot](https://releasebot.io/updates/google/firebase) and Firebase docs):
- Firebase Studio: new workspaces disabled Jun 22, 2026; shutdown Mar 22, 2027
  ([Wikipedia](https://en.wikipedia.org/wiki/Firebase_Studio)).
- Extensions: decommissioned Mar 31, 2027 ([FAQ](https://firebase.google.com/docs/extensions/faq-and-troubleshooting)).
- Firebase ML: turned down Jun 15, 2027.
- CocoaPods publishing: stops Oct 2026 ([doc](https://firebase.google.com/docs/ios/cocoapods-deprecation)).

**OSS / self-host.** None. Only the SDKs and the emulator suite are open.

**What worked:** zero-cost developer-loved products (Crashlytics, App Distribution) that plant the Firebase
SDK in every mobile app, and one console with one project model.

**What failed:** products that earn nothing (Dynamic Links) get shut down, and the resulting trust damage
is a recurring theme in the migration guides that competitors publish
([Airbridge](https://www.airbridge.io/en/blog/firebase-dynamic-links-alternatives),
[Branch](https://www.branch.io/resources/blog/firebase-dynamic-links-shutting-down/)).

### Supabase

**Products.** Postgres, Auth, Storage, Edge Functions, Realtime, Vector, Queues and Cron. Multigres (a
Postgres "operating system") entered open alpha in Jun 2026
([CNBC](https://www.cnbc.com/2026/06/04/database-startup-supabase-raises-500-million-10point5-billion-valuation.html)).

**Pricing.** One plan unlocks every product. The tiers are Free ($0, 2 active projects, paused after 1 week
idle, 50K auth MAU), Pro ($25/mo, 100K MAU then $0.00325/MAU, 50 SSO MAU then $0.015/MAU, $10 compute
credit), Team ($599/mo) and Enterprise ([pricing](https://supabase.com/pricing)). Each additional project
adds its own compute cost.

**OSS / self-host.** Apache-2.0 and self-hostable with Docker (license from the
[GitHub repo](https://github.com/supabase/supabase), not re-verified).

**Scale.** Raised $500M Series F at $10.5B (Jun 2026). Estimated $170M ARR (May 2026). More than 60% of new
databases are created by AI tools
([TechCrunch](https://techcrunch.com/2026/06/05/supabase-doubles-valuation-to-10b-in-8-months/),
[Sacra](https://sacra.com/c/supabase/)).

**Lesson.** Supabase bundles because every product hangs off one Postgres database. Auth is priced per MAU
and is the stickiest piece.

### Appwrite

**Products.** Auth, Databases, Storage, Functions, Messaging (push/email/SMS), Realtime, Sites (hosting) and
Firewall. All of them are on every plan ([pricing](https://appwrite.io/pricing)).

**Pricing.** Free: 75K MAU, 5 GB bandwidth, 2 GB storage, 750K executions. Pro: $25/mo per project with 200K
MAU, 2 TB bandwidth, 150 GB storage and 3.5M executions, then overages. Databases can be serverless or
dedicated (from $10/mo)
([pricing update](https://appwrite.io/blog/post/appwrite-pricing-update),
[Pro docs](https://appwrite.io/docs/advanced/billing/pro)).

**OSS / self-host.** BSD-3 and fully self-hostable (license unverified). This is the closest peer to Mocco's
"cloud and self-host with the same code" position.

**Lesson.** Pricing per project rather than per organization is simple to understand, but it penalizes teams
that run many small apps.

### Expo (EAS)

**Products.** EAS Build, Submit, Update (OTA), Workflows (CI), Hosting, Insights and Observe (performance
monitoring, GA on Aug 20, 2026) ([changelog](https://expo.dev/changelog/eas-observe-is-now-generally-available)).

**Pricing.** Every service is in every plan, with per-service quotas and usage-based overages
([pricing](https://expo.dev/pricing)):

| Plan | Price | Builds | Update MAU | Observe events |
|---|---|---|---|---|
| Free | $0 | 15 Android + 15 iOS | 1K (hard cap) | 100K |
| Starter | $19/mo | $45 credit | 3K, then $0.005/MAU tiering down to $0.00085 | 500K |
| Production | $199/mo | $225 credit | 50K | 500K |
| Enterprise | custom | $1,000+ credit | 1M+ | 500K |

Bandwidth is 100 GiB to 1 TiB plus 40 MiB per extra MAU. Hosting includes 100K requests, then $2 per 1M.
Production adds SSO and code signing.

**OSS.** The Expo SDK and the `expo-updates` client are MIT. The EAS services are closed. The update
protocol is open, so self-hosted update servers are possible.

**Recent news.** Raised $45M (Apr 2026) ([Ventureburn](https://ventureburn.com/expo-secures-45m-and-unveils-new-expo-agent-tool/)).

**Lesson.** Expo expanded from the framework into the whole release pipeline: build, submit, OTA, CI, then
monitoring. It sequenced products along the developer's own workflow, and OTA MAU is the pricing unit that
grows with the customer. Expo is Mocco's most direct OTA competitor. What it lacks is governance: approval
gates for who may push an update to production are unverified.

### Vercel

**Products.** Deployments and previews, rolling releases (with stage approval), Firewall/BotID, Web
Analytics, Speed Insights, Observability, Toolbar comments, Flags, Edge Config, Blob/storage, Queues,
Workflow, Sandbox and AI Gateway. Third-party products (auth, databases) come through a Marketplace
([docs](https://vercel.com/docs)).

**Flags.** Public beta, then GA on Apr 16, 2026 ([changelog](https://vercel.com/changelog/vercel-flags-ga)).
Hobby gets 10K flag requests per month. Pro pays $0.03 per 1K requests, and a page that evaluates many
flags from one source counts as one request. Limits are 100 flags on Hobby and 10K on Pro. Flags supports
OpenFeature, drafts discovered from code, and embedded definitions baked in at build time
([limits](https://vercel.com/docs/flags/vercel-flags/limits-and-pricing),
[overview](https://vercel.com/docs/flags/vercel-flags)).

**Pricing.** A seat plan (Pro) plus per-resource usage. Most new products ship as usage meters on top of
the existing plan.

**OSS.** Next.js and the Flags SDK are open. The platform is not self-hostable.

**Lesson.** Vercel ties each new product to the deployment. Flags are "per environment", evaluated in
runtime logs and measured in Web Analytics. This is the same "release context" argument Mocco makes, but
Vercel only makes it for apps hosted on Vercel. Mocco can make it for any CI and any host, including mobile.

### Sentry

**Expansion beyond errors.** Sentry added performance/tracing, session replay, cron monitors, uptime
monitors, logs (5 GB free, then $0.50/GB), continuous and UI profiling, the User Feedback widget, Codecov
(acquired 2022) and Seer, an AI debugger billed at $40 per active contributor per month. It also took in
Emerge Tools (mobile size analysis, snapshots, build distribution); "Size Analysis is now in Sentry"
([Emerge](https://www.emergetools.com/); acquisition date unverified, believed 2025).

**Pricing.** Developer (free, 1 user, 5K errors), Team ($26/mo), Business ($80/mo), Enterprise. Each data
type has its own PAYG overage: errors from $0.0003625, spans $0.000002, replays $0.00375, cron monitors
$0.78 each, uptime monitors $1.00 each. Every plan includes one cron monitor and one uptime monitor
([pricing](https://sentry.io/pricing/), [docs](https://docs.sentry.io/pricing/)).

**OSS / self-host.** Self-hosted under the Functional Source License, which converts to Apache/MIT after two
years (unverified).

**Lesson.** Sentry expands along the incident: from the error, to what caused it (deploys and releases), to
fixing it (Seer PRs). Sentry "releases" already link errors to deploys, which overlaps with Mocco's
correlation story. Mocco needs a Sentry integration, not a replacement.

### Intercom

**Products.** Messenger/live chat, shared inbox and tickets, help center, Fin AI agent, Copilot, outbound
(Proactive Support Plus) and phone.

**Pricing.** Essential $29, Advanced $85 and Expert $132 per seat per month. Fin costs $0.99 per outcome and
is also sold standalone on top of other helpdesks, with no seats but a monthly minimum
([pricing](https://www.intercom.com/pricing)).

**OSS.** None.

**Lesson.** The support bundle is messenger + inbox + help center, and it is priced per seat with AI priced
per outcome. Selling Fin on top of other vendors' helpdesks shows that the AI layer can be unbundled and
sold into competitors' installed base.

### Zendesk

**Suite.** Suite Team $55/agent/month (ticketing, messaging, live chat, voice, AI agents, knowledge base).
Suite Professional $115/agent/month. Enterprise is custom. AI agents are billed per automated resolution.
Add-ons include Copilot ($50), WEM ($50) and Contact Center ($83)
([pricing](https://www.zendesk.kr/pricing/)).

**Community forum.** Zendesk also has a community forum product (Gather), the one incumbent that bundles a
forum with support.

**OSS.** None.

### Atlassian and GitLab (DevOps suites)

**Atlassian.** Jira, Confluence, Bitbucket (deployment permissions), Compass, Jira Service Management,
Statuspage and Jira Product Discovery (feedback/ideas). Statuspage is Free (100 subscribers), Hobby $29,
Startup $99, Business $399 and Enterprise $1,499/mo, with private pages from $79/mo
([pricing](https://www.atlassian.com/software/statuspage/pricing)). Opsgenie stopped selling on Jun 4, 2025
and shuts down on Apr 5, 2027, with customers folded into Jira Service Management
([migration](https://www.atlassian.com/software/opsgenie/migration)).

The lesson from Atlassian: products it acquired and left separate (Opsgenie, Statuspage) end up
consolidated into the seat-priced flagship.

**GitLab.** Free, Premium ($29/user/mo, 10K compute minutes) and Ultimate (custom). Premium and above
include protected environments, deployment approvals and a status page. Feature flags come from an
Unleash-compatible integration. Duo Agent Platform uses GitLab Credits at $1 each, with 12–24 credits per
user included as a promotion ([pricing](https://about.gitlab.com/pricing/)). The core is open (MIT CE), with
proprietary EE tiers.

The lesson from GitLab: the "single application for DevOps" story sells to enterprise buyers, but each
module is shallower than the best point tool. GitLab's deployment approvals are the closest existing
feature to Mocco's governance core, but they only work inside GitLab CI.

### Better Stack

**Products.** Uptime monitoring, status pages, incident management/on-call, logs, metrics, traces and error
tracking.

**Pricing.** 10 monitors and 1 status page free. Each extra 50 monitors costs $25/mo, each extra status page
$15/mo, white-label $250/mo, and responders $34/mo ($29 yearly). Logs cost $0.10–0.35/GB to ingest plus
retention. Error tracking includes 100K exceptions free ([pricing](https://betterstack.com/pricing)).

**OSS.** None.

**Lesson.** Better Stack started with uptime and a status page, then moved up to logs and APM. A free
status page plus 10 monitors is the market's free-tier baseline, and Mocco's status page (#103) needs to at
least match it.

### Channel Talk (Korea)

**Products.** Channel Talk (messenger with the ALF AI agent), Channel Works (team chat, documents/knowledge
base, CRM marketing, workflows), Meet (phone) and AI Chief of Staff (analytics). Channel operates in Korea,
Japan and the US and claims 248,918 companies ([site](https://channel.io/en)).

**Pricing.** Free (basic chat). Early Stage $27/mo (3K managed users, 5 basic and 2 operator seats). Growth
$90/mo (up to 1M managed users). Enterprise is required above $10M revenue. On top of the plan, it meters
managed users ($0.03 down to $0.001), seats ($3 basic, $60 operator), ALF ($0.50 per chat participation),
workflow actions and marketing messages ([pricing](https://channel.io/en/pricing)).

**Lesson.** It dominates the Korean SMB and e-commerce support market with a hybrid model (seats plus
managed users plus AI usage) and a very low entry price. Mocco's messenger (#95) would compete with Channel
Talk head-on in Korea, and Mocco has no edge there except developer and release context.

### Hackle (Korea)

**Products.** A/B testing, feature flags, remote config, analytics and CRM marketing (in-app, push, Kakao
brand messages, SMS, coupons).

**Pricing.** Growth is 200,000 KRW/month plus usage (5M events/month). Enterprise is custom and is required
above KRW 10B investment or KRW 5B revenue ([pricing](https://hackle.io/pricing)).

**Lesson.** Hackle is the Korean PostHog-lite, with flags and experiments as the entry wedge. For Mocco's
flags (#101) in Korea, Hackle is the local incumbent, but it has no deploy governance.

### 2025–2026 entrants and expansions

- **Featurebase.** Support inbox and live chat, feedback boards, roadmap, changelog, help center, the Fibi
  AI agent and workflows. Free (1 seat), Growth $29, Professional $59, Enterprise $99 per seat per month,
  AI at $0.49 per resolution, and 86% off for startups ([pricing](https://www.featurebase.app/pricing)).
  It is the closest single competitor to Mocco's combined #95 + #96 + #98, and it undercuts Intercom on AI
  per resolution.
- **Userorbit.** Surveys, tours, changelog, feedback boards, roadmap, knowledge base, support suite and
  session replay, priced by MAU ($95/mo for 5K MAU, $249/mo for 10K) ([pricing](https://userorbit.com/pricing)).
  It shows the "product-ops all-in-one" category forming.
- **Vercel Flags (GA Apr 2026), Expo Observe (GA Aug 2026), PostHog Logs/Workflows/Desktop (2025–26).**
  The incumbents are all moving into adjacent products.
- **Airbridge (AB180, Korea).** Launched a Deep Link plan targeted at Dynamic Links refugees
  ([blog](https://www.airbridge.io/en/blog/introduce-deeplink-plan)). ChottuLink offers 25K MAU free with
  unlimited links ([blog](https://chottulink.com/blog/firebase-dynamic-links-shut-down-5-best-alternatives-for-2026/)).
- **Microsoft App Center / CodePush.** Retired Mar 31, 2025
  ([Microsoft](https://learn.microsoft.com/en-us/appcenter/retirement); page not re-fetched). This left
  Expo EAS Update and self-hosted CodePush servers as the defaults, which is why Mocco's OTA (#99) is
  timely.

## Cross-comparison table

Legend: **Y** = first-party product. **~** = partial or adjacent (see note). **x** = retired. Blank = none.

| Platform | Deploy governance | App reviews | Messenger | Help center | Forum | Feedback/roadmap/changelog | OTA | Identity | Feature flags | Deep links | Status page | Count (Y) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Mocco (plan)** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | 11 |
| PostHog | | | ~ (Workflows is outbound only) | | | ~ (Surveys) | | | Y | | | 1 |
| Firebase | | | ~ (In-App Messaging) | | | ~ (App Distribution tester feedback) | | Y | Y (Remote Config) | x (2025) | | 2 |
| Supabase | | | | | | | | Y | | | | 1 |
| Appwrite | | | ~ (Messaging is outbound) | | | | | Y | | | | 1 |
| Expo EAS | ~ (channels, Workflows; no approval roles verified) | | | | | | Y | | | | | 1 |
| Vercel | ~ (rolling release approvals, deployment protection; Vercel-hosted only) | | | | | ~ (Toolbar comments, internal) | | ~ (Marketplace) | Y | | | 1 |
| Sentry | | | | | | ~ (User Feedback widget) | ~ (build distribution via Emerge) | | | | ~ (uptime monitors, public page unverified) | 0 |
| Intercom | | | Y | Y | | ~ (News/outbound) | | | | | | 2 |
| Zendesk | | | Y | Y | Y | ~ (community ideas) | | | | | | 3 |
| Atlassian | ~ (Bitbucket deploy permissions) | | ~ (JSM chat) | Y (JSM/Confluence) | | Y (Jira Product Discovery) | | | | | Y (Statuspage) | 3 |
| GitLab | Y (protected envs + deployment approvals, GitLab CI only) | | | ~ (Service Desk) | | | | | Y | | Y (per pricing page) | 3 |
| Better Stack | | | | | | | | | | | Y | 1 |
| Channel Talk | | | Y | Y (Documents) | | | | | | | | 2 |
| Hackle | | | ~ (CRM push/in-app) | | | | | | Y | | | 1 |
| Featurebase | | | Y | Y | ~ (public boards) | Y | | | | | | 3 |
| Userorbit | | | ~ (support suite) | Y | | Y | | | | | | 2 |
| Airbridge / Branch | | | | | | | | | | Y | | 1 |

Takeaways:

1. **Nobody sells app-review analysis inside a platform.** It lives in point tools such as AppFollow and
   AppTweak (not profiled). Combined with Mocco's release correlation, it is uncontested.
2. **The release-engineering lines are scattered.** Governance (GitLab and Vercel, each inside its own
   host), OTA (Expo), flags (Vercel, GitLab, PostHog, Hackle), deep links (post-Firebase vacuum) and status
   (Atlassian, Better Stack) are each covered by one or two platforms, and nobody combines them. This is
   Mocco's most defensible bundle.
3. **The support lines come as a trio.** Messenger, help center and forum are bundled by Zendesk, Intercom,
   Featurebase and Channel Talk, all priced per seat, with AI per resolution at $0.49–$0.99. This is a
   crowded, price-competitive market.
4. **Identity is sticky, but a commodity.** Firebase, Supabase and Appwrite give away 50K–200K MAU.

## Pricing and packaging patterns

| Pattern | Who | How it works | Fit for Mocco |
|---|---|---|---|
| Per-product usage meter plus a separate free tier per product | PostHog, Sentry (per data type), Better Stack | Each product meters its own unit, and free allowances renew monthly | **Adopt.** Matches the epic's "pricing unit per product" question and lets small teams price independently |
| Org-level platform package separate from usage | PostHog (Boost $250 / Scale $750), GitLab tiers | SSO, SAML, RBAC, audit retention and SLA are sold per organization, not per product | **Adopt carefully.** Mocco's audit log and approvals are the core product, so gate retention, SSO/SCIM and multiple approvers rather than the audit trail itself |
| One plan unlocks every product, with usage overages | Supabase, Appwrite, Expo | A flat fee buys quotas for all products | Good for the first 2–3 release products (OTA + flags + governance as one "Release" plan) |
| Free loss-leader products | Firebase (Crashlytics, App Distribution, FCM) | Zero-cost products seed the SDK | Risky. Free products with no revenue line get killed (Dynamic Links). Price every product, even cheaply |
| Seat plus AI per outcome | Intercom ($0.99), Featurebase ($0.49), Zendesk, Channel Talk ($0.50) | Seats for agents, usage for AI | Needed if Mocco enters support. Undercut at around $0.30–0.49 per resolution, or sell AI only as usage |
| Managed-user / MAU metering | Channel Talk, Supabase/Appwrite auth, Expo Update, Userorbit | End users are the unit | Natural shared unit for identity, messenger and OTA, because one Mocco end-user counts once across products |
| Free in beta, priced at GA | PostHog | Launch free, charge once quality bar is met | **Adopt.** Lets Mocco ship ten products without ten billing launches |
| Per-project pricing | Appwrite Pro ($25/project) | Resources per project | Avoid. It punishes multi-app workspaces, which are Mocco's project/app model |
| Startup discounts | Featurebase (86% off), PostHog startup credits (unverified) | | Cheap acquisition channel |

Free-tier baselines Mocco must meet or beat per line:
- Flags: 1M requests (PostHog), 10K (Vercel Hobby), 100K requests/day (Firebase).
- Status: 1 page + 10 monitors (Better Stack), 100 subscribers (Statuspage).
- OTA: 1K MAU (Expo).
- Identity: 50K–75K MAU (Firebase, Supabase, Appwrite).
- Deep links: 25K MAU (ChottuLink).
- Support: 1 seat (Featurebase), basic chat (Channel Talk).

## Lessons for Mocco

**1. Pick the spine first, then sequence along it.** PostHog's products share persons and events. Supabase's
share Postgres. Expo's share the release pipeline. Mocco's spine should be two things, built as foundations
before or alongside the products that need them:
- (a) the **release event stream**: runs, approvals, what shipped where.
- (b) **end-user identity**: one `distinct_id` equivalent across messenger, feedback, forum, OTA and flags.

A product that uses neither of these (for example, a standalone help center) is only a cheaper Zendesk.

**2. The epic's order is sound. Tighten it into three waves by buyer.**
- **Wave A, Release suite.** Deploy governance, then OTA (#99) + flags (#101), then status page (#103).
  These have one buyer (the release engineer or tech lead), reuse gates and the audit log, and meet two open
  vacuums (CodePush retirement; Expo/Vercel lacking cross-host governance). Sell as one "Release" plan.
- **Wave B, Product loop.** App reviews (#94) + feedback/roadmap/changelog (#98). These are uncontested
  when correlated with releases ("rating dropped after 3.2.1 was approved by X"; "feature request
  auto-closed on deploy"). They are small builds on the scheduler, LLM and deploy events.
- **Wave C, Support.** Identity layer 1 (#100), then messenger (#95), help center (#96) and forum (#97).
  This is the most crowded wave (Intercom, Zendesk, Featurebase, Channel Talk in Korea). Enter only with
  the release-context wedge: the messenger shows the user's app version, OTA bundle and active flags, and
  the help center auto-updates from changelogs.
- **Deep links (#102) last, or partner.** Branch, AppsFlyer, Airbridge and ChottuLink already fought over
  the Firebase refugees. Mocco has little edge unless links become governed release artifacts, for example
  a link that targets a specific OTA channel.

**3. Launch each product the PostHog way.** Use concept, alpha, beta and GA stages. Keep beta free and
price at GA. Give each product its own changelog page and owner. Only enter markets with proven paying
demand, which all eleven lines have.

**4. Price per product. Do not discount bundles at launch.** Give every product its own meter and a
generous monthly free allowance:

| Product | Meter |
|---|---|
| Governance | Governed runs, or protected environments |
| OTA | Update MAU + GB |
| Flags | Evaluation requests |
| Status | Monitors + pages |
| Reviews | Tracked apps |
| Feedback | Tracked end-users or boards |
| Messenger, help center | Seats + AI resolutions |
| Identity | MAU |
| Deep links | Link clicks or MAU |

Sell organization features once as a workspace tier: SSO/SCIM, audit retention, multi-approver policies,
custom-domain count, SLA. This keeps AGPL self-hosters and small teams happy while enterprise pays for
governance depth. It also answers the epic's open question of whether to bundle: meter per product, tier
per workspace, and consider a "Release suite" plan once the three release products exist.

**5. Lock-in and network effects come from cross-product joins, not from discounts.**
- **Governance + OTA + flags.** Every production change, whether a deploy, an OTA push or a flag flip,
  goes through one gate and one hash-chained audit log. Once a compliance team relies on that log, leaving
  means losing audit continuity. This is the strongest lock-in.
- **Status page + governance.** Incidents get auto-annotated with the run and approver that preceded them.
  Better Stack and Statuspage cannot do this.
- **Feedback + changelog + deploy events.** Requests auto-close and changelogs auto-draft on release. The
  public boards are also SEO/network surfaces: end users visit Mocco-hosted pages, which gives Mocco
  distribution the way PostHog got it from word of mouth.
- **Identity + support trio + OTA.** A single end-user record makes each added product cheaper to adopt,
  the Supabase/Firebase auth stickiness effect. Migrating users out of an auth provider is the hardest
  migration in the stack.
- **Reviews + release correlation.** Weak lock-in but a strong acquisition hook, because it gives a free
  insight on day one.

**6. Protect trust, since shutdowns are the category's failure mode.** Dynamic Links, Opsgenie, App
Center/CodePush and Firebase Studio all left users stranded. Mocco's AGPL self-host is a real
differentiator here: "we cannot strand you." Make that explicit in positioning, and never ship a free
product with no revenue line.

**7. Self-host parity is a promise that others broke.** PostHog stopped selling self-host and dropped Helm,
and its open-source hobby deploy lacks several products. Supabase and Appwrite kept self-host but not full
parity. If every Mocco product runs on Node 22 + Postgres (per the stack conventions), then "all eleven
products self-hostable" is a claim no competitor makes. Keep that property when choosing vendors for each
product: only neutral surfaces, no cloud-only dependencies.

**8. Korea-specific.** The local incumbents are Channel Talk (support), Hackle (flags and experiments) and
Airbridge (links). None has release governance. Lead the Korean go-to-market with the release suite and
integrate with Channel Talk rather than fighting it early.

## Sources

- https://posthog.com/pricing
- https://posthog.com/platform-packages
- https://posthog.com/blog/multi-product-pricing
- https://posthog.com/handbook/product/releasing-new-products-and-features
- https://posthog.com/docs/self-host
- https://posthog.com/docs/self-host/open-source/disclaimer
- https://posthog.com/blog/sunsetting-helm-support-posthog
- https://www.howtheygrow.co/p/how-posthog-grows-the-power-of-being
- https://research.contrary.com/company/posthog
- https://sacra.com/c/posthog/
- https://www.thesaasnews.com/news/posthog-raises-75m-series-e-at-1-4b-valuation/
- https://flexprice.io/blog/posthog-pricing-guide
- https://blog.mean.ceo/posthog-news-september-2026/
- https://www.producthunt.com/products/posthog
- https://firebase.google.com/pricing
- https://firebase.google.com/support/dynamic-links-faq
- https://firebase.google.com/docs/extensions/faq-and-troubleshooting
- https://firebase.google.com/docs/ios/cocoapods-deprecation
- https://releasebot.io/updates/google/firebase
- https://en.wikipedia.org/wiki/Firebase_Studio
- https://supabase.com/pricing
- https://github.com/supabase/supabase
- https://www.cnbc.com/2026/06/04/database-startup-supabase-raises-500-million-10point5-billion-valuation.html
- https://techcrunch.com/2026/06/05/supabase-doubles-valuation-to-10b-in-8-months/
- https://sacra.com/c/supabase/
- https://appwrite.io/pricing
- https://appwrite.io/blog/post/appwrite-pricing-update
- https://appwrite.io/docs/advanced/billing/pro
- https://expo.dev/pricing
- https://expo.dev/changelog/eas-observe-is-now-generally-available
- https://ventureburn.com/expo-secures-45m-and-unveils-new-expo-agent-tool/
- https://vercel.com/docs/flags/vercel-flags
- https://vercel.com/docs/flags/vercel-flags/limits-and-pricing
- https://vercel.com/changelog/vercel-flags-ga
- https://sentry.io/pricing/
- https://docs.sentry.io/pricing/
- https://www.emergetools.com/
- https://www.intercom.com/pricing
- https://www.zendesk.kr/pricing/
- https://about.gitlab.com/pricing/
- https://www.atlassian.com/software/statuspage/pricing
- https://www.atlassian.com/software/opsgenie/migration
- https://betterstack.com/pricing
- https://channel.io/en
- https://channel.io/en/pricing
- https://hackle.io/pricing
- https://www.featurebase.app/pricing
- https://userorbit.com/pricing
- https://www.airbridge.io/en/blog/firebase-dynamic-links-alternatives
- https://www.airbridge.io/en/blog/introduce-deeplink-plan
- https://www.branch.io/resources/blog/firebase-dynamic-links-shutting-down/
- https://chottulink.com/blog/firebase-dynamic-links-shut-down-5-best-alternatives-for-2026/
- https://learn.microsoft.com/en-us/appcenter/retirement
