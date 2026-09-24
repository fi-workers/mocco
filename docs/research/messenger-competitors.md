---
title: Messenger — competitor research
description: Competitive landscape for an in-product customer messenger (web widget + React Native SDK) with a shared team inbox and AI assist, and where Mocco can win.
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, messenger]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-messenger-design.md
---

# Messenger — competitor research

## Summary

The in-app messenger market has become an AI-resolution market. The two big incumbents now charge per AI outcome on top of seats: Intercom, which renamed itself **Fin** in May 2026 and is being bought by Salesforce for about $3.6B, charges $0.99 per outcome on top of $29–$132 seats. Zendesk bundles 5–15 automated resolutions per agent and meters the rest, reportedly around $1.50–$2.00. In Korea and Japan, **Channel Talk** is the default. It repriced in November 2025: Growth went to KRW 120,000/month, and its ALF agent moved from per-resolution billing to KRW 500 per conversation it joins. The operator-side inbox is commoditized (Crisp, Chatwoot, Tawk.to and Freshchat all have free or near-free tiers), so an inbox alone is not a reason to switch. React Native support is uneven. Intercom and Crisp ship official native-module wrappers that need Expo dev builds; Zendesk has only a community wrapper; Chatwoot's official RN widget is a WebView; Tawk.to, Front and Plain have no RN SDK we could find. No competitor knows what the customer's team just shipped. Mocco does: it knows which release, OTA bundle, flag change and incident each end user is on. So the pitch is "the messenger that knows what you deployed", not "a cheaper Intercom". v1 should ship a solid human inbox with a pure-JS RN SDK (works in Expo Go, no native module), HMAC/JWT identity verification, and operator-approved AI drafts grounded in the Mocco help center. Autonomous AI resolution comes later.

## Market map

| Segment | Players | Buying motion |
|---|---|---|
| AI-first enterprise suites | Intercom/Fin, Zendesk, Salesforce (Agentforce + Fin after close), Freshworks (Freshchat) | Seats + per-resolution AI meter; sales-led above SMB |
| SMB all-in-one messengers | Channel Talk (KR/JP), Crisp (EU), Tidio, Tawk.to | Flat per-workspace plans, self-serve, marketing add-ons |
| Open source / self-host | Chatwoot (MIT core + EE), Papercups (dormant, unverified) | Free self-host, paid cloud per agent |
| Shared inbox / B2B support | Front, Help Scout (Beacon), Plain (API-first, dev-focused) | Per-seat or per-contacts-helped; email- and Slack-centric |
| Chat infrastructure with a desk bolted on | Sendbird (Desk + delight.ai), Stream, TalkJS | Developer APIs, MAU pricing; desk is an add-on |
| Korean messenger-channel consultation | HappyTalk, Kakao consultation-talk resellers, Naver TalkTalk | Enterprise/contact-center, Kakao channel is the front door |

## Competitor profiles

### 1. Channel Talk (Channel Corp.) — deep dive

- **What it is.** An all-in-one "AI messenger": web and app chat widget, team inbox, CRM (contacts, events), marketing (campaigns, one-off messages), workflows, the **ALF** AI agent, an internal team chat, and a phone/CTI add-on. In June 2026 it announced an AI "Chief of Staff" (CoS) product that pushes it further toward a business platform ([MT, 2026-06-04](https://www.mt.co.kr/future/2026/06/04/2026060414553711937); [Nate/ChannelCon Japan](https://news.nate.com/view/20260604n35831)).
- **Target.** Korean and Japanese SMB and mid-market, heavily D2C commerce: Cafe24 and Imweb shops, fashion, and apps. In Japan it reports about 25,000 customer companies, and more than half of the top 20 fashion brands with 100+ stores use it. Japan is about 20% of revenue, the 2026 Japan revenue target is KRW 15B, and Japan revenue grew about 50% last year ([MT, 2026-06-07](https://www.mt.co.kr/future/2026/06/07/2026060711434842883)).
- **Key features.** Omnichannel inbox (web/app chat plus Kakao, Naver, Instagram, LINE integrations), user profiles with events/page tracking, support bot and workflows, marketing campaigns, ALF (RAG over help docs plus "tasks" that call APIs), and a Cafe24/Imweb commerce integration. The free plan limits history to 30 days and events to 7 days ([Channel blog: free vs paid](https://channel.io/ko/blog/articles/compare-plans-5b2e886b)).
- **Pricing (2026).** Paid plans are Early Stage, Growth and Enterprise, priced on seats plus MU (managed users, meaning stored contacts) plus usage add-ons. The November 28, 2025 repricing ([notice](https://docs.channel.io/updates/ko/articles/%EC%A4%91%EC%9A%94-%EA%B3%B5%EC%A7%80-%EC%B1%84%EB%84%90%ED%86%A1-%EA%B0%80%EA%B2%A9%EC%A0%9C-%EA%B0%9C%ED%8E%B8-%EC%95%88%EB%82%B4251128--8bd5ddd0)) made these changes:
  - Growth went from KRW 96,000 to **KRW 120,000/month**, or KRW 90,000/month billed yearly (25% off). It includes 30,000 AU of ALF per month (1 AU = KRW 1).
  - Enterprise includes 100,000 AU/month of ALF.
  - Early Stage lost paid ALF access.
  - ALF v1 used to charge KRW 900 per resolution (first 1,000), then KRW 500. ALF v2 charges **500 AU per conversation it participates in, plus 200 AU per task execution**.
  - 50 workflow executions and 30 campaign executions are free, then billed per execution. Prepaid usage is 25% off ([billing guide](https://docs.channel.io/help/en/articles/0c124e99)).
  - G2 lists USD pricing of Early Stage $27/month (5 basic + 2 operator seats) and Growth $72/month (5 basic + 1 operator seat, extras unlimited) ([G2](https://www.g2.com/products/channel-talk/pricing)). These figures may predate the repricing (unverified).
- **Platforms/SDKs.** Web JS plugin; iOS, Android, Flutter and **React Native** (`react-native-channel-plugin`) SDKs ([RN quickstart](https://developers.channel.io/docs/react-native-quickstart)). The RN SDK wraps the native SDKs, which means CocoaPods and Gradle setup. There is no official Expo config plugin; the community uses `@sys1yagi/expo-channel-talk-plugin` ([npm](https://www.npmjs.com/package/@sys1yagi/expo-channel-talk-plugin)). The quickstart says nothing about New Architecture support (unverified). Push goes through Firebase messaging.
- **Identity.** `memberHash` is HMAC-SHA256 of `memberId` with a channel secret. Once enabled, a boot with a bad hash returns an `unauthenticated` boot status ([Member Hash](https://developers.channel.io/en/articles/cca4bd14)).
- **Open source/self-host.** No.
- **Strengths.** It is the category default in Korea, with polished UX, strong commerce integrations, marketing features in the same tool, strong AI resolution rates in Japan (about 80% claimed), and Korean-language support.
- **Weaknesses.** Pricing is complex and rising (seats + MU + AU + per-execution fees). It is commerce- and marketing-oriented, with no engineering or release context. The RN SDK is a native wrapper, and there is no self-host option.
- **Recent news.** The ALF v2 repricing (November 2025), ChannelCon Japan 2026 and the CoS launch, and the Japan team growing from 50 to 70 people by year end.

### 2. Intercom (renamed Fin, May 2026; Salesforce acquisition pending)

- **What it is.** The reference in-app Messenger, plus a helpdesk and the Fin AI agent (on its proprietary "Apex" model), across chat, email, WhatsApp, SMS, phone and Slack.
- **Target.** SaaS and fintech from startup to enterprise.
- **Pricing (2026).** Seats cost **Essential $29, Advanced $85, Expert $132** per seat per month billed annually; monthly billing is $39/$99/$139 ([Chatarmin](https://chatarmin.com/en/blog/intercom-pricing); [Drag](https://www.dragapp.com/blog/intercom-pricing/)). **Fin costs $0.99 per outcome.** An outcome is a resolution, a procedure handoff, or a qualification/disqualification/routing outcome. Fin on your own helpdesk requires a $49/month base that includes 50 outcomes ([fin.ai pricing](https://fin.ai/pricing); [Fin outcomes help](https://fin.ai/help/en/articles/13975800-fin-pricing-outcomes)). WhatsApp, SMS, phone and outbound are metered separately.
- **SDKs.** Web Messenger; iOS/Android; official **React Native** `@intercom/intercom-react-native`, which wraps the native SDKs. It ships an Expo config plugin (dev build required, not Expo Go), supports old and new architecture, and auto-generates an Android FirebaseMessagingService that coexists with expo-notifications ([GitHub](https://github.com/intercom/intercom-react-native); [npm](https://www.npmjs.com/package/@intercom/intercom-react-native)). This is the best-in-class RN SDK among competitors.
- **Identity.** Legacy HMAC-SHA256 `user_hash`, now superseded by JWT-signed Messenger auth ([Intercom help: JWTs](https://www.intercom.com/help/en/articles/10589769-authenticating-users-in-the-messenger-with-json-web-tokens-jwts); claim details unverified).
- **Open source/self-host.** No.
- **Strengths.** Mature product, the best AI agent in the category, the best SDKs, a huge integration ecosystem.
- **Weaknesses.** Expensive at scale, and total cost is hard to predict because of per-outcome billing. Its future inside Salesforce is uncertain. There is no self-host or data-residency option beyond US/EU/AU regions.
- **Recent news.** Renamed Fin in May 2026. Salesforce signed a definitive agreement on 2026-06-15 for about $3.6B ([Salesforce press](https://www.salesforce.com/news/press-releases/2026/06/15/salesforce-signs-definitive-agreement-to-acquire-fin/); [Irish Times](https://www.irishtimes.com/business/2026/06/15/salesforce-to-buy-fin-formerly-intercom-for-36bn/)). Salesforce Ben expects the close in Salesforce's fiscal Q4 2027 ([Salesforce Ben](https://www.salesforceben.com/salesforce-acquires-fin-formerly-intercom-adding-30k-ai-customers/)). One third-party blog claims the deal closed on 2026-09-10; we could not confirm that from a primary source (unverified). The uncertainty is a sales opening: Intercom customers wary of Salesforce lock-in are in play.

### 3. Zendesk (Messaging)

- **What it is.** A ticketing suite whose web and mobile "Messaging" SDKs replaced the legacy Chat. It adds AI agents, and Copilot for human agents.
- **Pricing (2026).** Support Team $19 per agent per month; Suite Team $55; Suite Professional $115; Enterprise by quote (annual billing, about 30% more monthly). Autonomous AI agents have been included in every plan since May 2026, with 5–15 free automated resolutions per agent per month. Overage is metered at an unpublished rate, reported at about $1.50–$2.00 per resolution. Copilot is +$50 per agent per month ([Richpanel](https://www.richpanel.com/learn/zendesk-pricing); [Drag](https://www.dragapp.com/blog/zendesk-pricing/)).
- **SDKs.** Official iOS/Android/Unity Messaging SDKs. For **React Native, the leading package is a community wrapper**, `react-native-zendesk-messaging` by leegeunhyeok ([GitHub](https://github.com/leegeunhyeok/react-native-zendesk-messaging)). It supports conversations, push, events, JWT user auth and metadata. RN teams depend on a volunteer.
- **Identity.** A JWT signed with a messaging auth key (per the wrapper's `loginUser(jwt)`; details unverified).
- **Strengths.** Enterprise ticketing depth. **Weaknesses.** Heavy, pricey, and RN is a second-class platform.

### 4. Crisp

- **What it is.** An EU (France) all-in-one: chat widget, shared inbox, knowledge base, chatbot/workflows, AI, campaigns, and status page add-ons.
- **Pricing (2026).** Priced per workspace, not per agent. Free $0 (2 seats); Mini $45 (4 seats, $5 of AI credits); Essentials $95 (10 seats, AI + workflows); Plus $295 (20 seats, then $10 per seat, "unlimited AI resolutions", ticketing). Only Plus can add seats ([Featurebase](https://www.featurebase.app/blog/crisp-pricing); [Drag](https://www.dragapp.com/blog/crisp-pricing/)).
- **SDKs.** An official **`crisp-sdk-react-native`**, rebuilt as an **Expo Module**. It requires RN 0.79+, iOS 15.1+ and a dev build (no Expo Go), and has push routing in "SDK-managed" or "coexistence" modes ([GitHub crisp-im](https://github.com/crisp-im/crisp-sdk-react-native); [docs](https://docs.crisp.chat/guides/chatbox-sdks/react-native-sdk/)). Its RN SDK is the second best after Intercom's.
- **Identity.** HMAC-SHA256 "user verification" of the email (unverified).
- **Strengths.** Cheap flat pricing, good UX, EU hosting. **Weaknesses.** Hard seat caps below Plus, AI credits run out, no release context.

### 5. Chatwoot (open source)

- **What it is.** An open-source omnichannel inbox (Rails + Vue) with web widget, email, WhatsApp, and the "Captain" AI (a reply-editor assistant since February 2026, and custom tool/API calling since April 2026) ([Chatwoot blog](https://www.chatwoot.com/blog/captain-inside-the-reply-editor/); [Captain tools](https://www.chatwoot.com/blog/captain-custom-tools)).
- **Pricing (2026).** Cloud tiers are Hacker $0, Startups $19, Business $39 and Enterprise $99 per agent per month (annual). Captain includes 300/500/800 credits per month, with extra credits at $20 per 1,000 ([eesel](https://www.eesel.ai/blog/chatwoot-pricing); [pricing](https://www.chatwoot.com/pricing)). Self-hosting the Community Edition is free, and paid self-hosted plans cost $19–$99 per agent ([self-hosted plans](https://www.chatwoot.com/pricing/self-hosted-plans)).
- **SDKs.** The official `@chatwoot/react-native-widget` is **a WebView** over the web widget (depends on react-native-webview and async-storage) ([GitHub](https://github.com/chatwoot/chatwoot-react-native-widget)). It works in Expo Go, but push and deep native integration are limited.
- **Identity.** HMAC `identifier_hash` ([DeepWiki](https://deepwiki.com/chatwoot/chatwoot/11.4-hmac-verification-and-identity-validation)).
- **Realtime.** ActionCable (Rails WebSockets) with Redis, on a long-running server, so it is not serverless-compatible.
- **Strengths.** It is the self-host reference and the closest analogue to Mocco's AGPL model. **Weaknesses.** Rails + Redis + Sidekiq to operate, a basic RN experience, and generic (no dev context).

### 6. Tawk.to

- Free forever, with unlimited agents, chats and sites. It makes money on add-ons: branding removal $29/month (the help center says $39), video/voice/screen-share $29–$49, AI Assist (Hobby free at 100 AI messages; $29/1k, $99/5k, $399/20k per month), and hired agents at $1 per hour ([tawk.to pricing](https://www.tawk.to/pricing/); [myaskai](https://myaskai.com/blog/tawk-to-complete-guide-2026)).
- **SDKs.** No official RN SDK; mobile apps embed the chat link in a WebView (unverified that no official RN package exists). No self-host.
- **Takeaway.** It sets the price anchor for a basic inbox: $0.

### 7. Front

- A shared inbox for email-heavy teams, with a web chat widget as one channel. In 2026 it moved to three tiers: Starter $25 (one channel type, 10 seats max), Professional $65 (up to 50 seats), Enterprise $105 per seat per month, annual ([Hiver](https://hiverhq.com/blog/front-pricing); [Drag](https://www.dragapp.com/blog/front-pricing/)).
- **SDKs.** Web chat only; no RN or mobile SDK (unverified). It is not really an in-product messenger competitor, but it competes for the "team inbox" budget.

### 8. Help Scout (Beacon)

- Priced per "contacts helped" per month. Free (5 users, 100 contacts); Standard $25, Plus $45, Pro $75 per user per month (Pro has a 10-user minimum). **AI Answers costs $0.75 per resolution** after a 3-month free trial, with a spend cap available ([Featurebase](https://www.featurebase.app/blog/helpscout-pricing); [Help Scout docs](https://docs.helpscout.com/article/1746-ai-resolutions-pricing)).
- **Beacon** is the embeddable widget: docs search, chat, and AI Answers. It has official iOS/Android Beacon SDKs; RN coverage is community wrappers only (unverified).
- **Takeaway.** The contacts-helped pricing unit is friendly to small teams. The widget is docs-first, which is the shape Mocco's messenger + help center pair should copy.

### 9. Freshchat (Freshworks)

- Free up to 10 agents; Growth $19, Pro $49, Enterprise $79 per agent per month (annual). **Freddy AI Agent:** the first 500 sessions are free, then $49 per 100 sessions (about $0.49 each) with no rollover. Freddy Copilot is +$29 per agent (Pro and up) ([eesel](https://www.eesel.ai/blog/freshdesk-freddy-ai-pricing); [Chatimize](https://chatimize.com/reviews/freshchat/)).
- **SDKs.** Official iOS/Android SDKs and an RN wrapper (`react-native-freshchat-sdk`, native module; official status and current maintenance unverified).

### 10. Plain (developer/B2B-focused)

- An API-first (GraphQL) support platform for B2B/devtools: Slack, Teams, Discord, email, in-app forms, live chat and help center in one inbox, integrated with Linear and Jira. Foundation $35 per seat per month; Horizon $299/month (3 seats, then $99 each); Frontier custom. All plans include the Ari AI agent and Sidekick credits (2,000 and 15,000 per month) ([Plain pricing](https://www.plain.com/pricing)). Raised $15M in February 2025 ([TechCrunch](https://techcrunch.com/2025/02/14/plain-pulls-in-15m-to-agregate-b2b-customer-services-chats-into-one-platform)).
- **SDKs.** Web chat/forms; no RN SDK (unverified).
- **Takeaway.** It is the closest to Mocco's developer-audience positioning, but it is B2B-channel (Slack) centric rather than consumer-app in-product chat, and it has no deploy context.

### 11. Sendbird Desk (plus delight.ai)

- A chat-infrastructure vendor. Desk is a ticketing layer on Sendbird Chat, free on the Developer plan. The AI agent was rebranded **delight.ai** in 2026, priced per conversation, and the rate is unpublished ([eesel](https://www.eesel.ai/blog/sendbird-ai-pricing); [aicxstack](https://www.aicxstack.com/blog/sendbird-desk-with-ai-agent-review)).
- **SDKs.** Strong RN chat UIKit. Desk SDKs are iOS/Android/JS, and RN Desk integration is manual (unverified).
- **Takeaway.** It is Korean-founded and has the infrastructure DNA we compete with, but it targets in-app user-to-user chat and its desk is secondary.

### 12. HappyTalk and the Korean consultation-channel tools

- **HappyTalk** positions itself as the number-one official Kakao consultation-talk ("sangdamtalk") partner. It sells chat consultation plus a work-automation chatbot to enterprises and contact centers, with a 14-day Enterprise trial. Its pricing page did not render for us, so pricing is unverified ([happytalk.io](https://happytalk.io/solution/happytalk); [price](https://happytalk.io/price)).
- **Naver TalkTalk and Kakao channel consultation** are the "front doors" Korean consumers already use. Channel Talk and HappyTalk integrate them. For a developer-app messenger, Kakao is a later channel (the issue lists it as out of scope for v1).
- **Takeaway.** Korean enterprise contact-center buyers are a different segment. Mocco should target Korean dev teams shipping RN apps, where Channel Talk is the incumbent.

## Feature matrix

Legend: Y = yes, P = partial/add-on/community, N = no, ? = unverified.

| Capability | Channel Talk | Intercom/Fin | Zendesk | Crisp | Chatwoot | Tawk.to | Front | Help Scout | Freshchat | Plain | Sendbird Desk | Mocco v1 (target) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Web widget | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | P | Y |
| Official RN SDK | Y (native) | Y (native, Expo plugin) | P (community) | Y (Expo Module) | Y (WebView) | N? | N? | P? | Y? (native) | N? | P | **Y (pure JS, Expo Go)** |
| Identity verification | HMAC | HMAC to JWT | JWT | HMAC? | HMAC | P? | ? | P? | JWT? | ? | token | **HMAC + JWT** |
| Push to app | Y | Y | Y | Y | P | N | N | ? | Y | N | Y | **Y (Expo/FCM/APNs)** |
| Email fallback | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | Y |
| Shared inbox, assignment | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y (round robin) |
| AI draft for operator | Y | Y | Y (Copilot $50) | Y | Y (Captain) | P | Y | Y | Y (Copilot $29) | Y | Y | **Y (grounded, cited)** |
| Autonomous AI agent | Y (ALF) | Y (Fin) | Y | Y | Y | Y | P | Y | Y | Y (Ari) | Y | N (later) |
| Help center in same product | Y | Y | Y | Y | Y | Y | N | Y | Y | Y | N | Y (#96) |
| Campaigns / outbound | Y | Y | P | Y | P | N | N | P | Y | N | P | N |
| Kakao/WhatsApp channels | Y | Y (WA) | Y | Y | Y | N | Y | N | Y | N | N | N |
| Open source / self-host | N | N | N | N | Y | N | N | N | N | N | N | **Y (AGPL)** |
| Release/deploy context | N | N | N | N | N | N | N | N | N | P (Linear) | N | **Y** |

## Pricing comparison

| Product | Entry paid | Mid | AI pricing unit | Free tier |
|---|---|---|---|---|
| Channel Talk | Early Stage (about $27/mo on G2, unverified post-repricing) | Growth KRW 120,000/mo (KRW 90,000 yearly) | 500 AU (about KRW 500) per AI-joined conversation + 200 AU per task | Yes (30-day history) |
| Intercom/Fin | $29/seat (Essential) | $85/seat (Advanced) | $0.99 per outcome; $49 base incl. 50 on other helpdesks | Trial only |
| Zendesk | $19/agent (Support Team) | $55 Suite Team / $115 Professional | 5–15 incl. per agent; overage about $1.50–$2.00 (unverified) | Trial only |
| Crisp | $45/workspace (4 seats) | $95 (10 seats) / $295 (20 seats) | Credits; "unlimited" on Plus | 2 seats |
| Chatwoot | $19/agent | $39/agent | 300–800 credits incl.; $20 per 1,000 | Hacker $0; OSS free |
| Tawk.to | $0 | Add-ons $29–$49 | $29 per 1k AI messages | Unlimited |
| Front | $25/seat | $65/seat | Included in Enterprise; Autopilot extra | No |
| Help Scout | $25/user | $45/user | $0.75 per AI resolution | 5 users / 100 contacts |
| Freshchat | $19/agent | $49/agent | $0.49/session after 500 free | Up to 10 agents |
| Plain | $35/seat | $299/mo (3 seats) | Credits included | Trial |
| Sendbird Desk | Free on Developer plan | Custom | Per conversation (unpublished) | Yes |

## Gaps and opportunities for Mocco

1. **No messenger knows what shipped.** Every competitor shows traits and page views. None can say "this user is on build 4.2.1 (OTA bundle b-83), which went out 40 minutes ago via run #512 approved by Jane, and flag `new-checkout` is on for them." Mocco already has runs, gates and audit, and plans OTA (#99), flags (#101) and status (#103). That context sidebar, plus "conversations spiking since deploy X", is the wedge.
2. **RN in Expo Go.** Every serious RN SDK wraps native code and needs a dev build. The only JS option (Chatwoot) is a WebView. A pure-TypeScript RN SDK (native RN views, `fetch`, and a WebSocket/poll transport, with optional push hooks through whatever notification library the app already uses) is a real developer-experience win and matches Mocco's SDK family.
3. **Self-host with a modern stack.** Chatwoot is the only serious self-host option, and it needs Rails + Redis + Sidekiq. Mocco running on Node 22 + Postgres alone (realtime degrades to SSE/poll without a vendor) is simpler to operate.
4. **Predictable AI pricing.** The market has moved to per-outcome meters ($0.49–$2.00), and buyers dislike unpredictable bills. Mocco v1 AI assist is operator-in-the-loop drafting, which is cheap to serve and can be bundled or credit-capped.
5. **Intercom/Salesforce disruption window.** Customers uneasy about the acquisition are evaluating alternatives in 2026.
6. **Korean dev teams.** Channel Talk's product is tuned for commerce and marketing; engineering-led app teams are underserved. Korean-first docs and support are an edge here (docs in English per the repo rule; localization is a product feature).

## Recommended positioning and v1 feature set

**Positioning:** "The in-product messenger that knows what you shipped. Web + React Native, open source, one workspace with your deploys, flags and releases."

**Table stakes (v1 must have)**
- A web widget (one `<script>` or npm package) and a React Native SDK with a chat screen, `identify()`, unread badge and push hook.
- Anonymous visitors, plus `identify` with **enforceable** HMAC or JWT identity verification.
- Automatic context: app version, platform, OS, locale, URL/screen.
- Inbox: open/snoozed/closed, assignee, unread, filters in the URL, internal notes, image attachments, user sidebar, round-robin assignment.
- Delivery: realtime while online; push (Expo/FCM/APNs) and email fallback when offline; browser and Slack notifications for operators.
- Rate limiting, origin allowlist, and blocking a contact.

**Differentiators**
- A release-context sidebar: the Mocco release/run/OTA bundle/flags matching the user's reported app version and environment.
- A pure-JS RN SDK that works in Expo Go.
- AI suggested replies grounded in help-center articles, with citations, always operator-sent, and acceptance tracked.
- Self-host on Node + Postgres, with pluggable realtime (a hosted vendor adapter or a built-in SSE/poll fallback).

**Deliberately skip (v1)**
- An autonomous AI agent (Fin/ALF-style auto-resolution). It comes later, opt-in.
- Campaigns, product tours, proactive outbound, and chatbots/workflow builders.
- Additional channels (email-in, Kakao, WhatsApp, Instagram, LINE), phone/voice/video, and co-browse.
- Native iOS/Android SDKs, Flutter, reply-by-email parsing, CSAT surveys and SLA policies.

## Sources

- https://docs.channel.io/updates/ko/articles/%EC%A4%91%EC%9A%94-%EA%B3%B5%EC%A7%80-%EC%B1%84%EB%84%90%ED%86%A1-%EA%B0%80%EA%B2%A9%EC%A0%9C-%EA%B0%9C%ED%8E%B8-%EC%95%88%EB%82%B4251128--8bd5ddd0
- https://docs.channel.io/help/en/articles/0c124e99
- https://channel.io/ko/blog/articles/compare-plans-5b2e886b
- https://www.g2.com/products/channel-talk/pricing
- https://developers.channel.io/docs/react-native-quickstart
- https://developers.channel.io/en/articles/cca4bd14
- https://www.npmjs.com/package/@sys1yagi/expo-channel-talk-plugin
- https://www.mt.co.kr/future/2026/06/04/2026060414553711937
- https://www.mt.co.kr/future/2026/06/07/2026060711434842883
- https://news.nate.com/view/20260604n35831
- https://fin.ai/pricing
- https://fin.ai/help/en/articles/13975800-fin-pricing-outcomes
- https://chatarmin.com/en/blog/intercom-pricing
- https://www.dragapp.com/blog/intercom-pricing/
- https://www.salesforce.com/news/press-releases/2026/06/15/salesforce-signs-definitive-agreement-to-acquire-fin/
- https://www.irishtimes.com/business/2026/06/15/salesforce-to-buy-fin-formerly-intercom-for-36bn/
- https://www.salesforceben.com/salesforce-acquires-fin-formerly-intercom-adding-30k-ai-customers/
- https://github.com/intercom/intercom-react-native
- https://www.intercom.com/help/en/articles/10589769-authenticating-users-in-the-messenger-with-json-web-tokens-jwts
- https://www.richpanel.com/learn/zendesk-pricing
- https://www.dragapp.com/blog/zendesk-pricing/
- https://github.com/leegeunhyeok/react-native-zendesk-messaging
- https://www.featurebase.app/blog/crisp-pricing
- https://www.dragapp.com/blog/crisp-pricing/
- https://github.com/crisp-im/crisp-sdk-react-native
- https://docs.crisp.chat/guides/chatbox-sdks/react-native-sdk/
- https://www.eesel.ai/blog/chatwoot-pricing
- https://www.chatwoot.com/pricing
- https://www.chatwoot.com/pricing/self-hosted-plans
- https://github.com/chatwoot/chatwoot-react-native-widget
- https://www.chatwoot.com/blog/captain-inside-the-reply-editor/
- https://www.chatwoot.com/blog/captain-custom-tools
- https://deepwiki.com/chatwoot/chatwoot/11.4-hmac-verification-and-identity-validation
- https://www.tawk.to/pricing/
- https://myaskai.com/blog/tawk-to-complete-guide-2026
- https://hiverhq.com/blog/front-pricing
- https://www.dragapp.com/blog/front-pricing/
- https://www.featurebase.app/blog/helpscout-pricing
- https://docs.helpscout.com/article/1746-ai-resolutions-pricing
- https://www.eesel.ai/blog/freshdesk-freddy-ai-pricing
- https://chatimize.com/reviews/freshchat/
- https://www.plain.com/pricing
- https://techcrunch.com/2025/02/14/plain-pulls-in-15m-to-agregate-b2b-customer-services-chats-into-one-platform
- https://www.eesel.ai/blog/sendbird-ai-pricing
- https://www.aicxstack.com/blog/sendbird-desk-with-ai-agent-review
- https://happytalk.io/solution/happytalk
- https://happytalk.io/price
