---
title: Feedback board, roadmap, and changelog — competitor research
description: Market scan of public feedback boards, roadmaps, and changelog tools (2026) and where Mocco's deploy-aware loop closing fits.
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, feedback]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-feedback-design.md
---

# Feedback board, roadmap, and changelog — competitor research

## Summary

The feedback-board category is mature and crowded. Every serious player ships the same core: a voting board, a status-driven public roadmap, a changelog, and an in-app widget. Price is what separates them, and the pricing unit varies: tracked users (Canny, Sleekplan), seats (Featurebase, Productboard makers, Jira Product Discovery creators), MAU (Beamer), or a flat fee per project (Nolt, Upvoty, Headway, AnnounceKit). Since 2024 the frontier has been AI. Canny Autopilot extracts and deduplicates feedback from tickets and review sites, Quackback ships duplicate detection with merge suggestions in open source, and Featurebase has grown into a full support suite with an AI agent. Loop closing always stops at the issue tracker. Canny, Featurebase, and Quackback all sync status from a GitHub or Jira issue, so a post is marked "complete" when the ticket closes. That is not when the code reaches users. No competitor we found knows about deployments, so none can say "this is live in production now". That gap is Mocco's wedge. Mocco already records every run, the commit it pinned, and the gates it passed. It can tell whether a merged PR is an ancestor of a successfully deployed commit, and only then suggest *Shipped*, draft the changelog entry, and email voters. In the open-source segment, Fider (Go, AGPL core since v0.33 with paid Pro features) and LogChimp (Node/Vue) are thin: neither has a changelog or tracker sync. Quackback (TypeScript, AGPL) is the most complete OSS entrant and the closest analogue to what Mocco would ship self-hosted. Our recommendation: ship table stakes at Canny-Core parity, make deploy-verified shipping the headline, and skip prioritization scoring and CRM revenue weighting in v1.

## Market map

| Segment | Players | Buyer | Pricing unit |
|---|---|---|---|
| Dedicated feedback + roadmap + changelog suites | Canny, Featurebase, Frill, Nolt, Upvoty, Sleekplan, ProductLift, UserJot, FeatureOS | PM / founder at a SaaS company, 5–500 staff | tracked users, seats, or flat per board |
| Enterprise idea management / product ops | UserVoice, Productboard (portal), Aha! Ideas | Product ops at mid-market/enterprise | seats or custom annual contracts ($6k–$40k+) |
| Tracker-native discovery | Jira Product Discovery, Linear Customer Requests / Asks | Engineering-led orgs already on the tracker | seats on the tracker |
| Changelog / release-comms only | Beamer, Headway, AnnounceKit, LaunchNotes, ReleaseGlow, Released | Marketing / PM | MAU (Beamer), flat (Headway, AnnounceKit), custom (LaunchNotes) |
| Open source / self-host | Fider, LogChimp, Quackback, Astuto (unverified: maintenance status) | Privacy-sensitive or cost-sensitive dev teams | free (self-host) plus optional cloud |
| Korean market | No dedicated Korean feedback-board vendor found. Teams tend to combine Channel Talk (messenger), Notion public pages, and Google Forms (unverified; based on search returning no local vendor) | — | — |

## Competitor profiles

### Canny (deep)
- **What it is:** The best-known dedicated feedback board: boards, votes, roadmap, changelog, widget, plus the Autopilot AI layer. Independent and unfunded, founded 2015 in San Francisco ([Tracxn](https://tracxn.com/d/companies/canny/__jPdzj0TyElv65n737N--YV3euCTdYp_XWoujpYCLl20)).
- **Target:** SaaS companies from startup to mid-market.
- **Key features:** voting boards with merge (votes consolidate), statuses, public roadmap, changelog, SSO identify, integrations with Jira, Linear, GitHub, ClickUp, Intercom, Zendesk, Salesforce, and HubSpot. **Autopilot** extracts feature requests from support tickets, calls, and review sites (G2, Capterra, app stores), and merges duplicates automatically or as suggestions ([Canny Autopilot help](https://help.canny.io/en/articles/8202451-autopilot), [review sources blog](https://canny.io/blog/autopilot-review-sources/)). Typeform reported 93% accuracy on 1,725 tickets ([Canny blog](https://canny.io/blog/introducing-autopilot/)).
- **GitHub:** Canny's GitHub App links posts to *open* issues. Status rules change the post when the issue closes, and sync now runs both ways ([Canny GitHub help](https://help.canny.io/en/articles/3481076-github-integration), [two-way sync changelog](https://feedback.canny.io/changelog/two-way-status-sync-for-project-management-integrations)). The sync keys off issue state; deploys are never considered.
- **Pricing (2026):** Free up to 25 tracked users. Core from $19/mo and Pro from $79/mo (annual, 100 tracked-user floor; Pro is $99 billed monthly). At 1,000 tracked users Core is $249 and Pro is $529. Business/Enterprise is custom above 5,000 tracked users. A tracked user is anyone who posts, votes, or comments, and the count never resets ([Canny billing help](https://help.canny.io/en/articles/9131812-canny-s-billing-plans), [Formbricks](https://formbricks.com/blog/canny-pricing)). Starter and Growth were retired in 2025 ([Userorbit](https://userorbit.com/blog/canny-pricing-guide)).
- **Platforms/SDK:** JS widget, SSO token identify, REST API, no official React Native SDK (unverified).
- **OSS/self-host:** no.
- **Strengths:** brand, integration breadth, most mature AI dedupe.
- **Weaknesses:** tracked-user pricing climbs steeply and punishes engagement. Loop closing is tied to tracker state, not delivery.

### Featurebase (deep)
- **What it is:** Started as a Canny alternative and in 2025–2026 became an all-in-one support plus feedback suite: live chat, ticketing, help center, boards, roadmap, surveys, changelog, and the "Fibi" AI agent ([Formbricks](https://formbricks.com/blog/featurebase-pricing)).
- **Target:** startups and SMBs that want one tool in place of Intercom plus Canny. This is the same bundling thesis as Mocco's.
- **Key features:** boards, votes, merge, AI duplicate detection, roadmap, changelog with email, embeddable widgets, revenue-weighted prioritization. The GitHub integration pushes posts to issues (manually or automatically), and sync rules map issue progress to post status ([Featurebase GitHub help](https://help.featurebase.app/articles/9380267-github-integration)). There is a versioned REST API, whose default version is `2026-01-01.nova` ([docs](https://docs.featurebase.app/rest-api/changelogs)).
- **Pricing (2026):** Free (1 seat). Growth $29/seat/mo annual ($37 monthly), Professional $59 ($75), Enterprise $99 ($129). AI resolutions went from $0.29 to $0.49 between May and July 2026. Branding removal is $69/mo, and unlimited AI Copilot is $19/agent/mo ([Formbricks](https://formbricks.com/blog/featurebase-pricing), [FeatureOS](https://featureos.com/blog/featurebase-pricing)).
- **OSS/self-host:** no.
- **Strengths:** generous free tier, modern UI, bundle economics.
- **Weaknesses:** usage-based AI fees make cost unpredictable. Status sync is tracker-driven only.
- **Recent news:** the support-suite pivot and the per-resolution AI price increase in 2026.

### Productboard (portal) (deep)
- **What it is:** A product-management platform. The customer-facing "portal" lets users vote on and submit ideas that feed Productboard's insights and prioritization.
- **2026 change:** Pricing collapsed into one product, **Spark**, at $15/maker/mo annual ($19 monthly). AI runs on credits (250 per maker per month; top-ups are $5 per 50 or $60/yr per 600). Essentials, Pro, and Scale are gone. Contributors are free and unlimited. The free tier includes the customer portal ([Productboard pricing](https://www.productboard.com/pricing/), [Spark FAQ](https://support.productboard.com/hc/en-us/articles/48438638045459-Spark-pricing-and-billing-FAQ), [Formbricks](https://formbricks.com/blog/productboard-pricing)).
- **Strengths:** deep prioritization, links insights to features, strong with enterprise PMs.
- **Weaknesses:** the portal is secondary to the PM workspace. It has no native changelog (unverified for Spark) and no delivery awareness.

### UserVoice (deep)
- **What it is:** Enterprise idea management with account-level feedback, revenue attribution, and Salesforce/Zendesk capture.
- **Pricing (2026):** No self-serve signup and no free plan. Reported figures: from about $16k/yr, with an average contract around $21k/yr. Some sources list Growth at $999/mo (1,000 users), Team $1,299, and Strategic $1,499; others say pricing is fully custom. There are no seat charges ([Quackback](https://quackback.io/blog/uservoice-pricing), [UserJot](https://userjot.com/blog/uservoice-pricing)). The published tiers are unverified.
- **Strengths:** enterprise trust, CRM depth.
- **Weaknesses:** price, dated UX, no developer or deploy angle.

### Quackback (OSS, deep, emerging)
- **What it is:** A TypeScript, AGPL-3.0 open-source alternative to Canny, UserVoice, and Productboard. It has boards, roadmap, changelog, SSO/OIDC, a REST API, 25 integrations (GitHub, Linear, Jira, Slack, Intercom, Zendesk, Salesforce), a built-in MCP server, and AI duplicate detection with reasoned merge suggestions, sentiment, and summaries. Self-hosted installs are fully entitled and make no outbound calls ([quackback.io/open-source](https://quackback.io/open-source), [dev.to launch](https://dev.to/mortondev/introducing-quackback-open-source-feedback-platform-with-a-built-in-mcp-server-mo3)).
- **Why it matters:** It has the same license and self-host story as Mocco and is the closest OSS feature analogue. Our differentiation has to come from deploy awareness and the bundle, not from the board.

### Frill
- **What:** ideas board, roadmap, announcements (changelog), surveys, and a widget. Announcements can be scheduled and boosted in the widget ([frill.co](https://frill.co/), [roadmap](https://frill.co/features/roadmap)).
- **Pricing:** from $25/mo with unlimited admins on every paid tier. Privacy, surveys, and white-label are add-ons ([Frill pricing](https://frill.co/pricing), [Fdback](https://fdback.io/blog/frill-pricing)). Higher tier prices are unverified.
- **Strengths:** polished widget, flat pricing. **Weaknesses:** light integrations, no deploy awareness.

### Nolt
- **What:** a simple, clean voting board with roadmap. Unlimited users and admins, and SSO even on the entry plan.
- **Pricing:** Essential $29/mo (1 board); Pro reported at $50 or $69/mo for up to 5 boards, depending on the source ([Fdback](https://fdback.io/blog/nolt-pricing), [Sleekplan comparison](https://sleekplan.com/alternative/nolt-io)).
- **Strengths:** simplicity, 4.9/5 reviews. **Weaknesses:** no changelog (unverified), minimal AI.

### Upvoty
- **What:** boards, roadmap, changelog, custom domain, CSS, SSO, and API on all tiers.
- **Pricing:** Power $15/mo, Super $25, Hyper $49, Enterprise $79. Tiers differ mainly by project count. Users have reported unannounced price increases ([TrustRadius](https://www.trustradius.com/products/upvoty/pricing), [UserJot](https://userjot.com/blog/top-8-upvoty-alternatives-2025)).

### Sleekplan
- **What:** board, roadmap, changelog, and CSAT/NPS behind one floating widget, billed per workspace.
- **Pricing:** Free (1 board, 25 tracked users), Indie $13/mo (100 users, changelog and widget), Business (no user limit), Enterprise $63/mo with SSO ([Sleekplan pricing](https://sleekplan.com/pricing), [Features.Vote](https://features.vote/alternative/sleekplan)).

### Fider (OSS)
- **What:** Go + PostgreSQL feedback portal with public boards, votes, statuses, tags, REST API, webhooks, and OAuth. It went **open core at v0.33.0**: the core stays AGPL-3.0, while moderation and search indexing are paid Pro features. Fider Cloud is the managed option ([GitHub](https://github.com/getfider/fider), [Fider blog](https://www.fider.io/blog/self-hosted-feedback-tools-vs-cloud)).
- **Gaps:** no changelog, no roadmap view, no AI, no native tracker integration ([Quackback OSS roundup](https://quackback.io/blog/open-source-feedback-tools)).

### LogChimp (OSS)
- **What:** Node.js + PostgreSQL + Vue feedback board and roadmap, about 1.1k GitHub stars ([GitHub](https://github.com/logchimp/logchimp)).
- **Gaps:** essentials only: no changelog, AI, or tracker sync (unverified in the latest release).

### Jira Product Discovery
- **What:** Atlassian's idea and prioritization tool tied to Jira delivery work. Ideas link to epics, and "release tracks" are Premium-only. Voting and commenting come from free contributors inside the org. The public, anonymous voting board is weak; published views are read-only (unverified for 2026).
- **Pricing:** Free (3 creators), Standard $10/creator/mo, Premium $25. Contributors are free ([UserJot](https://userjot.com/blog/jira-product-discovery-pricing), [Quackback](https://quackback.io/blog/jira-product-discovery-pricing)).
- **Relevance:** Closest to "idea → delivery" tracking, but the delivery signal is still ticket status, not production.

### Linear Customer Requests / Asks
- **What:** Linear models *customers* and attaches *customer requests* to issues. Requests arrive from Slack (Asks), Intercom, Zendesk, and Front. There is no public voting board or public changelog UI. Linear Asks and the Zendesk and Intercom integrations sit on Business ($16/user/mo annual); Basic is $10 and Free covers 250 issues ([Quackback](https://quackback.io/blog/linear-pricing), [Linear pricing](https://linear.app/pricing)).
- **Relevance:** engineering teams' default intake. Mocco should import and link from it, not compete with it.

### Beamer (changelog)
- **What:** in-app changelog and notification widget with segmentation. Feedback and NPS are add-ons at $99/mo each.
- **Pricing:** Free under 1,000 MAU, Starter $49/mo (5k MAU), Pro $99 (10k), Scale $249 (50k), plus $50 per extra 5k MAU. Anyone who loads the widget counts as an MAU ([Featurebase](https://www.featurebase.app/blog/beamer-pricing), [Fdback](https://fdback.io/blog/beamer-pricing)).

### Headway (changelog)
- **What:** minimal changelog widget and page. Free, or Pro at $29/mo flat (custom domain, branding, Slack/Twitter, scheduling). No MAU caps ([headwayapp.co](https://headwayapp.co/), [Worknotes](https://www.worknotes.ai/blog/changelog-tools-pricing-comparison)).

### AnnounceKit (changelog)
- **What:** changelog with 10+ widget modes, AI post generation, feature requests with Jira sync, NPS, SAML.
- **Pricing:** Essentials $79/mo annual (1 user), Growth $129, Scale $339, Enterprise custom ([Worknotes](https://www.worknotes.ai/blog/announcekit-pricing), [Capterra](https://www.capterra.com/p/190137/AnnounceKit/pricing/)).

### LaunchNotes (changelog / release comms)
- **What:** enterprise release communications with audience-segmented announcements, a subscriber portal, and a roadmap. Quote-based pricing, reported at $6k–$44k/yr with an average around $19k ([Vendr](https://www.vendr.com/buyer-guides/launchnotes), [LaunchNotes pricing](https://www.launchnotes.com/pricing)). No acquisition or shutdown found as of 2026.

## Feature matrix

Legend: Y = yes, P = partial / add-on, N = no, ? = unverified.

| Capability | Canny | Featurebase | Productboard | UserVoice | Frill | Nolt | Upvoty | Sleekplan | Fider | LogChimp | Quackback | JPD | Linear | Beamer | Headway | AnnounceKit | LaunchNotes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Public voting board | Y | Y | Y (portal) | Y | Y | Y | Y | Y | Y | Y | Y | P | N | P (add-on) | N | P | N |
| Merge duplicates (votes carry) | Y | Y | Y | Y | Y | Y | ? | ? | Y | ? | Y | Y | Y | ? | N | ? | N |
| AI duplicate detection | Y | Y | Y (credits) | ? | N | N | N | N | N | N | Y | P | P | N | N | N | N |
| Public roadmap | Y | Y | Y | P | Y | Y | Y | Y | N | Y | Y | P | N | N | N | P | Y |
| Changelog + email | Y | Y | N? | N | Y | N? | Y | Y | N | N | Y | N | P (own) | Y | Y | Y | Y |
| RSS | ? | Y? | N | N | ? | N | ? | ? | N | N | ? | N | N | Y? | Y? | Y | Y? |
| In-app widget | Y | Y | P | Y | Y | Y | Y | Y | N | N | Y | N | N | Y | Y | Y | Y |
| GitHub issue link + status sync | Y | Y | ? | N | N | N? | N | Y? | N | N | Y | N (Jira) | Y (native) | N | N | N | N |
| Intake from support/reviews | Y (Autopilot) | Y (own inbox) | Y | Y | P | N | N | N | N | N | Y | Y | Y | N | N | N | N |
| Knows production deploy | N | N | N | N | N | N | N | N | N | N | N | P (release tracks) | N | N | N | N | N |
| Self-host / OSS | N | N | N | N | N | N | N | N | Y (AGPL core) | Y | Y (AGPL) | N | N | N | N | N | N |
| React Native SDK | ? | ? | N | ? | ? | N | N | ? | N | N | ? | N | N | ? | N | ? | N |

## Pricing comparison (entry paid tier and scale point, 2026)

| Product | Free tier | Entry paid | Around 1k engaged users / mid-team | Unit |
|---|---|---|---|---|
| Canny | 25 tracked users | Core $19/mo (100 TU) | Core $249, Pro $529/mo @1k TU | tracked users (never reset) |
| Featurebase | 1 seat | Growth $29/seat/mo | 3 seats Pro ≈ $177/mo + AI fees | seats + AI resolutions |
| Productboard | yes (portal incl.) | Spark $15/maker/mo | 5 makers ≈ $75/mo + credits | makers |
| UserVoice | no | ~$1,000+/mo (unverified tiers) | ~$21k/yr avg | contract |
| Frill | trial | $25/mo | add-ons raise cost | flat + add-ons |
| Nolt | trial | $29/mo (1 board) | $50–69/mo (5 boards) | boards |
| Upvoty | trial | $15/mo | $49–79/mo | projects |
| Sleekplan | 25 TU | Indie $13/mo | Business (no user cap), Enterprise $63 | workspace |
| Fider | self-host free | Cloud (price unverified) | — | self-host / cloud |
| LogChimp | self-host free | — | — | — |
| Quackback | self-host free | cloud (unverified) | — | self-host / cloud |
| Jira Product Discovery | 3 creators | $10/creator/mo | Premium $25 | creators |
| Linear | 250 issues | Basic $10/user/mo | Business $16 (Asks) | seats |
| Beamer | <1k MAU | $49/mo (5k MAU) | $99–249/mo | MAU |
| Headway | yes | Pro $29/mo | $29/mo | flat |
| AnnounceKit | trial | $79/mo | $129–339/mo | flat per project |
| LaunchNotes | no | ~$6k/yr | ~$19k/yr avg | contract |

## Gaps and opportunities for Mocco

1. **Deploy-verified shipping.** Every competitor treats "issue closed" or "PR merged" as done. Mocco can prove the fix is live by checking that the PR's merge commit is an ancestor of the commit a run deployed successfully, and can name when it happened and who approved the gate. Nobody else can close the loop at production.
2. **Changelog drafted from what shipped.** Mocco knows the set of PRs contained in a deploy, so it can draft a release note that groups user-facing posts, with the gate and run as provenance. AnnounceKit and Beamer generate text from a prompt; none generate it from the deployed diff.
3. **Pricing that does not punish engagement.** Tracked-user and MAU pricing (Canny, Beamer) is the most-cited complaint in alternative roundups. A flat per-project price, or bundling into the Mocco workspace, is an easy win.
4. **Self-host with everything included.** Fider paywalls moderation and search; Quackback shows a full-featured AGPL product is viable. Mocco can match it and add deploy awareness.
5. **One intake across products.** Canny Autopilot proves cross-source extraction sells. Mocco can offer intake from its own reviews (#94), messenger (#95), and forum (#97) without third-party connectors or per-resolution fees.
6. **Korean market.** We found no local dedicated vendor. English-only incumbents with USD per-user pricing leave room for a localized, KRW-billed offering (unverified demand).
7. **Developer-native surface.** A versioned `/v1` API, typed web and React Native SDKs, and an MCP-friendly API (Quackback ships MCP) suit Mocco's developer buyers.

## Recommended positioning

**"The feedback board that knows when it shipped."** Collect requests, show the roadmap, and tell every voter the moment the fix is live in production. The verification comes from the deploy pipeline you already govern with Mocco, not from a ticket someone remembered to close.

### v1 feature set

**Table stakes**
- Board: posts, votes, comments, categories, staff official response, merge duplicates with vote carry-over.
- Statuses as constants: Under review, Planned, In progress, Shipped, Closed.
- Public roadmap (kanban of Planned / In progress / Shipped) and a public changelog page with RSS.
- Email notifications to voters and subscribers on status change, with one-click unsubscribe.
- Lightweight identity (verified email) plus signed-token identify from the customer's app.
- GitHub issue and PR linking.
- Embeddable "what's new" widget (web first, React Native through the messenger SDK shell).

**Differentiators**
- Deploy-verified *Shipped* suggestion: merged PR contained in a successful Mocco run leads to a suggestion, a drafted changelog entry, and voter notification. Auto-apply is opt-in.
- Changelog entries carry deploy provenance ("Live since run #123, approved by the sre gate").
- LLM duplicate detection at submit time ("similar posts exist") and staff merge suggestions, with a full-text fallback when no LLM is configured (self-host friendly).
- Native intake from Mocco reviews, messenger, and forum ("convert to feedback" keeps provenance).
- Flat per-project pricing, self-host fully entitled.

**Deliberately skip (v1)**
- Prioritization scoring (RICE, impact/effort) and revenue-weighted votes from CRM.
- Private or segmented boards per customer account.
- Third-party intake connectors (Intercom, Zendesk, G2, Salesforce). Use our own products first.
- Jira and Linear sync (GitHub only in v1).
- Surveys (NPS/CSAT), which Sleekplan and Frill bundle.
- Autopilot-style extraction from arbitrary call transcripts.

## Sources

- https://help.canny.io/en/articles/9131812-canny-s-billing-plans
- https://formbricks.com/blog/canny-pricing
- https://userorbit.com/blog/canny-pricing-guide
- https://tracxn.com/d/companies/canny/__jPdzj0TyElv65n737N--YV3euCTdYp_XWoujpYCLl20
- https://help.canny.io/en/articles/8202451-autopilot
- https://canny.io/blog/introducing-autopilot/
- https://canny.io/blog/autopilot-review-sources/
- https://help.canny.io/en/articles/3481076-github-integration
- https://feedback.canny.io/changelog/two-way-status-sync-for-project-management-integrations
- https://formbricks.com/blog/featurebase-pricing
- https://featureos.com/blog/featurebase-pricing
- https://help.featurebase.app/articles/9380267-github-integration
- https://docs.featurebase.app/rest-api/changelogs
- https://www.productboard.com/pricing/
- https://support.productboard.com/hc/en-us/articles/48438638045459-Spark-pricing-and-billing-FAQ
- https://formbricks.com/blog/productboard-pricing
- https://quackback.io/blog/uservoice-pricing
- https://userjot.com/blog/uservoice-pricing
- https://quackback.io/open-source
- https://dev.to/mortondev/introducing-quackback-open-source-feedback-platform-with-a-built-in-mcp-server-mo3
- https://quackback.io/blog/open-source-feedback-tools
- https://frill.co/
- https://frill.co/pricing
- https://frill.co/features/roadmap
- https://fdback.io/blog/frill-pricing
- https://fdback.io/blog/nolt-pricing
- https://sleekplan.com/alternative/nolt-io
- https://www.trustradius.com/products/upvoty/pricing
- https://userjot.com/blog/top-8-upvoty-alternatives-2025
- https://sleekplan.com/pricing
- https://features.vote/alternative/sleekplan
- https://github.com/getfider/fider
- https://www.fider.io/blog/self-hosted-feedback-tools-vs-cloud
- https://github.com/logchimp/logchimp
- https://userjot.com/blog/jira-product-discovery-pricing
- https://quackback.io/blog/jira-product-discovery-pricing
- https://linear.app/pricing
- https://quackback.io/blog/linear-pricing
- https://www.featurebase.app/blog/beamer-pricing
- https://fdback.io/blog/beamer-pricing
- https://headwayapp.co/
- https://www.worknotes.ai/blog/changelog-tools-pricing-comparison
- https://www.worknotes.ai/blog/announcekit-pricing
- https://www.capterra.com/p/190137/AnnounceKit/pricing/
- https://www.vendr.com/buyer-guides/launchnotes
- https://www.launchnotes.com/pricing
