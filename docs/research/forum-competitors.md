---
title: Community forum — competitor research
description: Competitive landscape for a hosted, per-project community forum (Q&A + discussion) inside Mocco, and the build-vs-embed evidence behind the v1 scope.
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, forum]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-forum-design.md
---

# Community forum — competitor research

## Summary

The forum market splits into four camps: open-source forum engines (Discourse, Flarum, NodeBB, Apache Answer), all-in-one creator/brand community suites (Circle, Bettermode), enterprise customer-community suites (Khoros, Higher Logic Vanilla, Gainsight Customer Communities), and "free but closed" developer defaults (GitHub Discussions, Discord). Discourse is the reference product for developer-tool communities: free and open source to self-host, but the hosted plan that lets you plug in your own user identity (DiscourseConnect SSO) starts at $500/month, and self-hosting means running a Ruby/Redis/Sidekiq container next to our Node + Postgres stack. The enterprise suites charge five figures a year and sell on CRM/customer-success integration, not on engineering context. The developer defaults are free but either tie the forum to GitHub accounts (Discussions) or hide answers from search engines (Discord, which spawned Answer Overflow purely to fix indexing). Nobody links a forum thread to what actually shipped: no competitor can say "this bug was fixed in the deploy that reached production on Tuesday" because none of them knows about deploys. The 2025-2026 news points the same way for everyone: AI answers, AI moderation, and MCP connectors are now table stakes (Discourse AI, Circle MCP, Gainsight Community MCP), and the community-analytics layer is being absorbed by bigger vendors (Orbit sunset by Postman, Common Room being acquired by Zoom). Mocco should build a deliberately small forum (Q&A-first, crawlable, LLM pre-screen, shared end-user identity) whose value is the cross-links: thread to help-center article, thread to feedback post, thread to "fixed in release X".

## Market map

| Segment | Players | Buyer | Price band |
|---|---|---|---|
| Open-source forum engines (self-host, some with paid hosting) | Discourse, Flarum, NodeBB, Apache Answer | Dev tools, OSS projects, technical communities | $0 self-host; $100-$500+/mo hosted |
| Creator / brand community suites | Circle, Bettermode | Creators, SaaS marketing, course businesses | $89-$1,500/mo |
| Enterprise customer communities | Khoros (IgniteTech), Higher Logic Vanilla, Gainsight Customer Communities (ex-inSided) | Enterprise support / customer success orgs | ~$24k+/yr, sales-led |
| Free developer defaults | GitHub Discussions, Discord (+ Answer Overflow to make it indexable) | OSS maintainers, startups | $0 (Answer Overflow freemium) |
| Community analytics / CRM (adjacent) | Common Room (Zoom), Orbit (sunset) | DevRel, GTM | Sales-led |
| Korean market | Naver Cafe, Kakao open chat, company-built dev forums (Kakao DevTalk, KakaoPay Developers forum) | Consumer brands, API platforms | $0 or in-house build |

## Competitor profiles

### Discourse (hosted + open source) — the reference

- **What:** The default open-source forum for developer products (Rails + Postgres + Redis + Sidekiq). Topics, categories, tags, trust levels, likes, accepted answers (Solved plugin, bundled), chat, a large plugin ecosystem, first-party Discourse AI (summaries, sentiment, AI search, spam detection, toxicity triage).
- **Target:** Dev tools, OSS projects, SaaS support communities.
- **Pricing (hosted, 2026):** Free $0 (2 staff, 500k pageviews/mo, 20k emails, 5 GB, 100k AI credits/day, no custom domain, no API); Pro $100/mo (5 staff, custom domain, API/webhooks, 100k emails, 20 GB); Business $500/mo (15 staff, **DiscourseConnect SSO and OAuth2/OIDC**, 300k emails, 100 GB); Enterprise custom (1M+ pageviews, 1.5M+ emails, SLA). Third-party roundups also cite a $20/mo "Starter" tier, but the official pricing page fetched on 2026-09-24 did not show one (unverified). Source: discourse.org/pricing.
- **Self-host:** GPLv2, officially supported only via Docker; minimum 1-2 GB RAM with swap, 4 GB recommended for production; one container bundles Postgres, Redis, Sidekiq, Rails. Source: github.com/discourse/discourse INSTALL.md, onout.org sizing guide.
- **Embedding:** The official embed shows a topic's comments inside an iframe on a host page and auto-creates a topic per URL, but "users have to navigate to your forum to post replies". There is no headless/UI-less mode short of the REST API. Source: meta.discourse.org/t/31963.
- **AI moderation:** Discourse AI spam detection flags the post for review, can silence the user, hide the post, and hide the topic if it was the first post; admins approve false positives. Configurable LLM; also usable with EU-hosted models. Source: meta.discourse.org/t/343541, communiteq.com.
- **Strengths:** Mature, fast, excellent SEO (server-rendered crawler view), huge ecosystem, trust-level anti-spam.
- **Weaknesses for Mocco:** Identity integration is gated at $500/mo per community; one instance per community (no multi-tenant per project); a second runtime (Ruby) that does not run on Vercel; theming/SSO/webhook glue per customer.
- **Recent news:** AI credits added to every hosted tier (2025-2026); AI-based moderation experiments on Meta (2025). Source: discourse.org/ai, meta.discourse.org/t/357865.

### Circle

- **What:** All-in-one community platform (spaces, posts, courses, events, live, payments, native apps).
- **Target:** Creators, course businesses, B2B brand communities.
- **Pricing (2026):** Professional $89/mo (unlimited members, 3 admins, 20 spaces, 2% transaction fee, custom domain, no API/SSO); Business $199/mo (APIs, remove branding, standard SSO); Scale $419/mo (custom SSO, AI agents, 100 spaces); Circle Plus custom (branded apps). Source: circle.so/pricing.
- **Recent news:** April 2026 release shipped Circle MCP and AI agent upgrades; June 2026 "AI-native platform" where admins describe the community in natural language. Source: community.circle.so/c/product-updates/april-2026-release, circle.so/blog/ai-native-community-platform.
- **Strengths:** Polished UX, mobile apps, monetization.
- **Weaknesses:** Not Q&A-first, weak public SEO for support content (community content often gated), no developer/engineering context.

### Flarum (open source)

- **What:** Lightweight PHP forum (MIT), extension-based, modern single-page UI.
- **Status:** 2.0 is still in release-candidate stage; 2.0.0-rc.3 shipped 2026-06-09 and is described as "almost ready for everyone". Source: discuss.flarum.org/d/39406.
- **Pricing:** Free self-host; no first-party hosted plan (community hosts exist; unverified).
- **Strengths:** Simple, MIT license, good for small communities.
- **Weaknesses:** Slow release cadence (2.0 in development for years), PHP runtime, SEO relies on extensions, small ecosystem vs Discourse.

### Khoros (now IgniteTech)

- **What:** Enterprise community (the former Lithium platform) plus social care.
- **Target:** Large B2C/B2B enterprises.
- **Pricing:** Sales-led, enterprise contracts (public numbers unavailable; unverified).
- **Recent news:** Acquired by IgniteTech in May 2025; IgniteTech positions it as a "rebuild" around an AI Community Orchestrator and "answer engine era" discoverability, and promises no forced migration from Classic Community. Source: prnewswire.com (IgniteTech acquires Khoros), khoros.ai/the-story.
- **Strengths:** Scale, gamification, enterprise integrations.
- **Weaknesses:** Ownership churn and platform rebuild risk; price; irrelevant to small dev teams.

### Higher Logic Vanilla

- **What:** Hosted customer community (the former Vanilla Forums) with ideation, Q&A, knowledge base integrations.
- **Pricing:** Sales-led; Capterra lists a starting price around $24,000/year flat (unverified by vendor). Source: capterra.com/p/141384/Vanilla/.
- **Strengths:** Mature moderation, ideation module, SSO options.
- **Weaknesses:** Enterprise price floor; the open-source Vanilla core is no longer the product's focus (unverified).

### Gainsight Customer Communities (ex-inSided)

- **What:** B2B SaaS customer community tied to Gainsight CS (health scores, journey orchestration). inSided acquired 2022 and rebranded.
- **Pricing:** Not public; no free tier; bundle discounts of 15-25% when bought with other Gainsight products. Source: trustradius.com, oliv.ai.
- **Recent news (2026):** AI Answers analytics, Gainsight Community MCP connector (query community via Claude), Developer Studio (May 2026) to build/version custom widgets in GitHub. Source: support.gainsight.com Pulse 2026 release notes, cxtoday.com.
- **Strengths:** CS data integration, AI answers, ideation.
- **Weaknesses:** Only sensible inside a Gainsight stack; enterprise pricing.

### Bettermode (ex-Tribe)

- **What:** Hosted, customizable community platform (Q&A, discussions, events, polls, ideation), headless-ish with a design studio and API.
- **Pricing (2026):** Starter $149/mo (up to 10k members, 5 collaborators, limited API, social login); Growth $1,500/mo (25k members, OAuth2 SSO, full API + webhooks, Ask AI, federated search); Premium custom (SAML/JWT SSO, 90-day audit log, SLA). AI spam detection on all plans. Source: bettermode.com/pricing.
- **Strengths:** Good SEO, Q&A templates, embeddable widgets.
- **Weaknesses:** Steep jump from Starter to Growth for SSO/API; member caps.

### GitHub Discussions

- **What:** Free forum attached to a repo or org: categories, Q&A format with marked answers (author or triage+ role), polls (max 8 options), upvotes, org-level discussions, convert issue to discussion and back. Source: docs.github.com/en/discussions, github.blog.
- **Pricing:** Free.
- **Strengths:** Zero setup, lives next to code, indexed by search engines, issue linking.
- **Weaknesses:** Requires every user to have a GitHub account (fine for OSS, wrong for end users of a consumer/B2B app); no custom domain or branding; no LLM moderation control; no link to help center; no private deploy context.

### Discord (+ Answer Overflow)

- **What:** Chat server with forum channels; the de facto developer community tool.
- **Pricing:** Free.
- **Problem:** Content is invisible to search engines and to LLM crawlers; users re-ask the same questions. Source: dev.to "Why Discord sucks for developer communities", kamranayub.com.
- **Answer Overflow:** Open-source bot/site that indexes Discord help and forum channels into Google, adds AI answers trained on community data and analytics; freemium with a 14-day trial of Advanced (exact prices unverified). Its existence is proof that "public and searchable" is a paid-for need. Source: answeroverflow.com/about.

### Apache Answer (open source)

- **What:** Stack Overflow-style Q&A (Go + TypeScript), plugins for auth, search, storage, notifications, spam. ASF top-level project since January 2025; 2.0.2 released 2026-07-21 with "AI Reasoning", email intervals, safer login. Source: answer.apache.org, github.com/apache/answer/releases.
- **Pricing:** Free (Apache-2.0), self-host only.
- **Strengths:** Q&A-first data model (questions, answers, accepted answer, votes, reputation), permissive license, single Go binary.
- **Weaknesses:** Separate runtime; no hosted multi-tenant offering; small ecosystem.

### NodeBB

- **What:** Node.js forum (GPLv3) with Redis/Mongo/Postgres backends; v4 (2025) made ActivityPub federation core, still shipping 4.x releases in 2026 (v4.16). Source: docs.nodebb.org/activitypub, github.com/NodeBB/NodeBB/releases.
- **Pricing:** Hosted plans reported at $250-$750/mo (TrustRadius, data dated 2024; unverified for 2026). Source: trustradius.com/products/nodebb/pricing.
- **Strengths:** Node stack, realtime, federation.
- **Weaknesses:** Hosted price, smaller developer-tool footprint.

### Common Room / Orbit (community analytics, adjacent)

- **Orbit** was acquired by Postman in April 2024 and sunset within 90 days (per 2026 roundup; unverified primary source).
- **Common Room:** Zoom announced a definitive agreement to acquire Common Room on 2026-07-02, positioned as an extension of Zoom Revenue Accelerator. Source: abmatic.ai / vibewatch.io 2026 landscape (secondary).
- **Takeaway:** Community analytics is drifting toward GTM/sales tooling; a lightweight "who asks, what goes unanswered, what topics spike after a release" report is enough for Mocco's audience and is a natural release-correlation feature.

### Korean market

- **Naver Cafe:** Free, dominant consumer community host in Korea; walled garden, weak for product support SEO and no API for support workflows (general knowledge; unverified detail).
- **Kakao open chat / KakaoTalk channels:** Chat, not searchable knowledge.
- **In-house developer forums:** Kakao Developers runs DevTalk (Q&A on Kakao APIs with app notifications for answers); KakaoPay Developers has its own forum. Source: developers.kakao.com docs, developers.kakaopay.com/forum. Korean API platforms build their own rather than buy, which suggests demand for a forum that sits next to docs and developer console.
- No Korean vendor sells a Discourse-class hosted forum to developer companies that we could find (unverified absence).
- Search note: Postgres has no built-in Korean text-search configuration; Korean FTS needs the `simple` config plus trigram (`pg_trgm`) or an external tokenizer. This matters for the team's home market.

## Feature matrix

Legend: Y = yes, P = partial / add-on / higher tier, N = no.

| Capability | Discourse | Circle | Flarum | Khoros | HL Vanilla | Gainsight CC | Bettermode | GH Discussions | Discord+AO | Apache Answer | NodeBB | Mocco v1 (planned) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Categories + tags | Y | Y | Y | Y | Y | Y | Y | Y (categories) | P | Y | Y | Y |
| Q&A accepted answer | Y | P | P (ext) | Y | Y | Y | Y | Y | N | Y | P | Y |
| Votes | Y (likes) | Y (likes) | P | Y | Y | Y | Y | Y | N | Y | Y | Y |
| Pinned / locked | Y | Y | Y | Y | Y | Y | Y | Y | P | Y | Y | Y |
| First-post approval queue | Y | P | P | Y | Y | Y | Y | N | N | Y | Y | Y |
| LLM spam/toxicity screening | Y (Discourse AI) | P | N | Y | P | P | Y | N | N | P (plugin) | P | Y (flag only) |
| Public SEO rendering | Y | P | P | Y | Y | Y | Y | Y | P (AO) | Y | Y | Y |
| Custom domain | P (Pro+) | Y | self-host | Y | Y | Y | Y | N | P (AO) | self-host | Y | Y (foundation) |
| Bring-your-own identity (SSO/JWT) | P (Business $500) | P (Business+) | P (ext) | Y | Y | Y | P (Growth+) | N (GitHub only) | N | P (plugin) | P | Y |
| Email notifications + unsubscribe | Y | Y | Y | Y | Y | Y | Y | Y (GitHub) | N | Y | Y | Y |
| Postgres FTS search | Y | Y | P | Y | Y | Y | Y | Y | P | Y | Y | Y |
| Thread -> help-center article | P (plugin) | N | N | P | P | Y | P | N | N | N | N | Y |
| Thread -> feedback / idea | P | N | N | Y (ideas) | Y (ideation) | Y (ideas) | Y | P (issue convert) | N | N | N | Y |
| "Fixed in release" deploy context | N | N | N | N | N | N | N | P (issue close) | N | N | N | Y (differentiator) |
| Audit log of moderation | P (staff log) | N | N | Y | Y | Y | P (Premium) | N | N | P | P | Y (hash-chained) |
| AI answer / MCP | Y | Y (MCP) | N | Y | P | Y (MCP) | Y (Ask AI) | P (Copilot) | Y (AO) | P | N | Later |
| Self-host | Y (Docker, Ruby) | N | Y (PHP) | N | N | N | N | N | AO OSS | Y (Go) | Y (Node) | Y (Node 22 + Postgres) |
| Open source | GPLv2 | N | MIT | N | N | N | N | N | AO OSS | Apache-2.0 | GPLv3 | AGPL-3.0 |

## Pricing comparison

| Product | Free tier | Entry paid | Tier where BYO identity/SSO unlocks | Enterprise |
|---|---|---|---|---|
| Discourse hosted | $0 (2 staff, no custom domain) | Pro $100/mo | Business $500/mo | Custom |
| Discourse self-host | Free (GPLv2) | Server ~4 GB RAM | Included (DiscourseConnect) | n/a |
| Circle | Trial only | Professional $89/mo | Business $199/mo (standard SSO); Scale $419/mo (custom SSO) | Circle Plus custom |
| Bettermode | Trial only | Starter $149/mo (10k members) | Growth $1,500/mo (OAuth2); Premium (SAML/JWT) | Custom |
| NodeBB hosted | Self-host free | ~$250/mo (unverified) | Included (plugins) | ~$750/mo+ (unverified) |
| Higher Logic Vanilla | Free version listed (unverified) | ~$24k/yr (unverified) | Included | Sales-led |
| Khoros | None | Sales-led | Included | Sales-led |
| Gainsight CC | None | Sales-led | Included | Sales-led, bundle discounts 15-25% |
| GitHub Discussions | Free | n/a | GitHub accounts only | n/a |
| Discord + Answer Overflow | Free | AO Advanced (price unverified) | Discord accounts only | n/a |
| Apache Answer / Flarum | Free self-host | n/a | Plugin/extension | n/a |

The price gap Mocco can exploit: "custom domain + bring your own user identity + API" costs $500/mo on Discourse, $199-419/mo on Circle, $1,500/mo on Bettermode. A Mocco workspace already has the identity, the domain, and the API.

## Gaps and opportunities for Mocco

1. **Release context nobody else has.** Mocco knows which PR reached production and when. A thread linked to a GitHub issue can show "Fixed in production on <date>, run #123", and subscribers can be notified automatically. The feedback board (#98) does this for feature requests; the forum does it for bug reports and "is this broken?" questions.
2. **One end-user identity across messenger, help center, forum, and feedback.** Competitors either own identity (GitHub/Discord accounts) or charge for SSO. Mocco's end-user identity foundation makes the same user the author of a forum thread, a feedback vote, and a messenger conversation, so support staff see one history.
3. **Content flywheel across products.** Thread -> help-center article (with auto-translation from #96), thread -> feedback post (#98), unanswered-thread -> messenger AI suggestion corpus (#95). Every competitor treats these as separate products or plugins.
4. **Crawlable and LLM-readable by default.** Discord's failure (and Answer Overflow's existence) shows public answers are the core value. JSON-LD `QAPage` / `DiscussionForumPosting`, sitemaps, and clean HTML are cheap to do well once public rendering exists.
5. **Governed moderation.** Moderation actions land in the existing hash-chained audit log; enterprise suites sell this, open-source forums have only staff logs.
6. **Korean search quality.** Postgres FTS with `simple` + trigram handles Korean acceptably where naive English stemming fails; a small edge for the home market.
7. **Self-host parity.** Same Node 22 + Postgres deployment as the rest of Mocco; Discourse self-host needs a separate Ruby/Redis container.

## Recommended positioning and v1 feature set

**Positioning:** "The support forum that knows what you shipped." A Q&A-first public forum per project, signed in with the same end-user identity as the rest of Mocco, where good answers become docs, requests become roadmap items, and bug threads close themselves when the fix reaches production.

**Build vs embed verdict (evidence):** Embedding hosted Discourse per customer project costs $500/mo per community before SSO works and cannot be resold per project; embedding self-hosted Discourse breaks the "runs on Vercel and on Node 22 + Postgres" rule by adding Ruby/Redis/Sidekiq; the official Discourse embed does not even allow replying in place. The pieces that make the product (identity, cross-links, release context, audit) are exactly what an embed cannot reach. Build small; keep a "connect existing Discourse" integration (webhooks + DiscourseConnect as the IdP) as a later option for customers who already run one. Details in the design doc.

**Table stakes (v1):**
- Categories, threads (Markdown), tags, replies, votes, accepted answer (author or staff), staff badges, pinned/locked.
- Report/flag, hide, delete, ban, first-post approval queue, LLM spam/toxicity pre-screen that only flags.
- Email notifications (reply to my thread, reply to a thread I follow, mention) with one-click unsubscribe.
- Postgres FTS search (shared approach with help center), including Korean via `simple` + trigram.
- Public, crawlable pages with structured data, sitemap, custom domain.
- Anonymous read, signed-in write; rate limits and CSRF on every write.

**Differentiators (v1 or v1.1):**
- Promote thread to help-center article (draft with source link and author credit).
- Convert thread to feedback post (votes and followers carried over as subscribers).
- Link thread to a GitHub issue/PR; "fixed in production" banner and follower notification on deploy.
- Moderation actions in the hash-chained audit log.
- Similar-thread suggestions when composing (FTS first, embeddings later).

**Deliberately skip (v1):**
- Reputation/trust levels, badges, gamification (use a simple "new user" flag for the approval queue instead).
- Private/gated categories, groups, DMs, chat, events, courses, payments.
- Plugin/theme system (offer brand colors/logo only).
- ActivityPub federation, auto-translation of posts, AI-generated answers on the forum page, native mobile apps.
- Importers from Discourse/Discord (later, only if demand).

## Sources

- https://www.discourse.org/pricing
- https://www.discourse.org/ai
- https://meta.discourse.org/t/embed-discourse-comments-on-another-website-via-javascript/31963
- https://meta.discourse.org/t/discourse-ai-spam-detection/343541
- https://meta.discourse.org/t/experiments-with-ai-based-moderation-on-discourse-meta/357865
- https://www.communiteq.com/discoursehosting/kb/using-an-eu-based-llm-for-ai-powered-content-moderation-in-discourse/
- https://github.com/discourse/discourse/blob/main/docs/INSTALL.md
- https://onout.org/discourse/self-hosting-production/
- https://circle.so/pricing
- https://community.circle.so/c/product-updates/april-2026-release
- https://circle.so/blog/ai-native-community-platform
- https://discuss.flarum.org/d/39406-flarum-200-rc3-released-built-by-the-community-almost-ready-for-everyone
- https://www.prnewswire.com/news-releases/ignitetech-acquires-khoros-to-transform-customer-connections-in-the-ai-answer-engine-era-302465365.html
- https://khoros.ai/the-story/
- https://www.capterra.com/p/141384/Vanilla/
- https://www.trustradius.com/products/vanilla-forums/pricing
- https://www.trustradius.com/products/gainsight-customer-communities/pricing
- https://www.oliv.ai/blog/gainsight-pricing-cost-per-user
- https://support.gainsight.com/cc/Release_Notes/Current_Release_Notes_-_2026/Pulse_2026_Release_Notes_for_Customer_Communities_(CC)
- https://www.cxtoday.com/community-social-engagement/gainsight-community-platform-digital-customer-hub/
- https://bettermode.com/pricing
- https://docs.github.com/en/discussions/collaborating-with-your-community-using-discussions/participating-in-a-discussion
- https://github.blog/news-insights/product-news/whats-new-in-github-discussions-organization-discussions-polls-and-more/
- https://dev.to/bdbchgg/why-discord-sucks-for-developer-communities-2fg1
- https://kamranayub.com/discord-forum-channels/
- https://www.answeroverflow.com/about
- https://answer.apache.org/
- https://github.com/apache/answer/releases
- https://docs.nodebb.org/activitypub/
- https://github.com/NodeBB/NodeBB/releases/tag/v4.16.0
- https://www.trustradius.com/products/nodebb/pricing
- https://abmatic.ai/blog/common-room-alternatives
- https://vibewatch.io/blog/32-tool-community-sentiment-landscape
- https://developers.kakao.com/docs/latest/en/getting-started/kakao-developers
- https://developers.kakaopay.com/forum/
