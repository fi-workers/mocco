---
title: Help center — competitor research
description: Competitor landscape for a hosted help center / product docs product with automatic LLM translation and per-locale staleness tracking (GitHub issue #96).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, help-center]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-help-center-design.md
---

# Help center — competitor research

## Summary

The help-center market splits into support-suite knowledge bases (Zendesk, Intercom/Fin, Help Scout, Featurebase, Channel Talk), standalone knowledge-base tools (Document360, HelpDocs, Notion wrappers), developer-docs platforms (GitBook, Mintlify, ReadMe) and open-source frameworks (Docusaurus, Fumadocs, Nextra). Translation is still the weak spot almost everywhere. Zendesk offers on-demand AI translation but no automatic staleness detection: editors flag outdated translations by hand. Intercom's help center does not machine-translate articles at all; teams bolt on Lokalise or marketplace apps. Help Scout relies on Weglot/Crowdin integrations. The two products that do automatic re-translation on source change (GitBook, Featurebase) treat translations as a pure function of the source. GitBook does not let humans edit a translation at all, and a glossary change triggers a full re-translation. Nobody we found combines (a) automatic LLM translation, (b) segment-level staleness so only changed paragraphs are re-translated, and (c) protection of human-reviewed text. Translation management systems (Crowdin, Lokalise, Phrase) have that rigor but are separate, expensive products ($59–$1,045+/mo) that need a connector. Mocco can ship the TMS-grade state machine inside the help center at help-center prices. It can also add a signal no one else has: flagging articles for review when a linked code path actually reaches production.

## Market map

| Segment | Players | Buyer | Translation story |
|---|---|---|---|
| Support-suite knowledge bases | Zendesk Guide, Intercom/Fin Help Center, Help Scout Docs, Featurebase, Channel Talk Documents | Support leads, per-agent seat pricing | Mixed: on-demand AI (Zendesk), none (Intercom, Help Scout), auto (Featurebase) |
| Standalone knowledge bases | Document360, HelpDocs, HelpKit / Super (Notion-as-CMS) | Docs/support teams, flat or quote pricing | Document360 has Eddy AI translation + review reminders; others limited |
| Developer docs platforms | GitBook, Mintlify, ReadMe | DevRel / engineering, per-site pricing | GitBook and Mintlify auto-translate (credits/words billed); ReadMe via TMS integrations |
| OSS docs frameworks | Docusaurus, Fumadocs, Nextra | Engineers self-hosting docs-as-code | Folder-per-locale i18n, no staleness; Crowdin integration common |
| Translation platforms (adjacent) | Crowdin, Lokalise, Phrase, Weglot | Localization managers | Full TM/MT/review workflows, sold separately |

## Competitor profiles

### Zendesk Guide / Zendesk Knowledge (deep)

- **What it is:** The knowledge base / help center module of Zendesk Suite, now marketed as "Zendesk Knowledge" with generative search and AI agents on top.
- **Target:** Mid-market and enterprise support organizations.
- **Key features:** Categories → sections → articles; themes (Curlybars templating); multiple help centers (1 on Suite Team, up to 5 on Professional, up to 300 on Enterprise); AI article drafting from tickets ("knowledge builder"); generative search; content blocks.
- **Translation:** Stored per-locale translations. AI translation (generative) sits in the editor: pick a language, click Translate, review, publish. It is on-demand, not automatic, and does not support content blocks. It supports term exclusions. Staleness is manual: publishers "flag" a translation as outdated (API property `outdated`). No automatic detection. ([Zendesk AI translation](https://support.zendesk.com/hc/en-us/articles/8717609637018-Translating-articles-in-your-help-center-using-AI), [managing translations](https://support.zendesk.com/hc/en-us/articles/4408821505306-Managing-help-center-translations-for-articles), [Translations API](https://developer.zendesk.com/api-reference/help_center/help-center-api/translations/))
- **Pricing (2026):** Guide is only sold inside Suite. Suite Team $55/agent/mo and Suite Professional $115/agent/mo. Suite Enterprise was renamed "Suite Enterprise + Copilot" and moved to sales-only. AI Copilot, QA and WFM are billed as add-ons. ([featurebase.app/blog/zendesk-pricing](https://www.featurebase.app/blog/zendesk-pricing), [eesel](https://www.eesel.ai/blog/zendesk-guide-pricing))
- **Platforms/SDKs:** Web Widget, mobile SDKs, Help Center REST API.
- **OSS/self-host:** No.
- **Strengths:** The default choice, a mature theme system, strong Help Center API, and 80+ languages for AI agents.
- **Weaknesses:** Per-agent pricing for a docs site, manual staleness, AI translation only on higher Knowledge tiers.
- **Recent news:** A September 2026 release roundup on AI and Knowledge ([community](https://community.zendesk.com/product-updates/september-2026-release-roundup-ai-and-knowledge-22401)). Internalnote tracks the Zendesk help-center AI features ([internalnote](https://internalnote.com/whats-new-in-zendesk-ai-for-the-help-center/)).

### Intercom / Fin Help Center (deep)

- **What it is:** The help center that ships with the Intercom (renamed "Fin") customer platform. It is the primary knowledge source for the Fin AI Agent.
- **Target:** SaaS support teams.
- **Key features:** Collections → articles; public or private help center; multilingual help center on Advanced; browser-language detection; Fin answers from articles.
- **Translation:** Articles are **not** machine-translated. Upgrading to Advanced only unlocks writing articles in several languages. Fin can translate fallback-language content at answer time. The long-running community idea "Automatic Translation of Help Center Articles" is still open, and teams use Lokalise or marketplace apps (Swifteq, TranslateDesk). ([community idea](https://community.intercom.com/ideas/automatic-translation-of-help-center-articles-13223), [add translations](https://www.intercom.com/help/en/articles/3107405-add-translations-to-public-articles), [Fin multilingual](https://www.intercom.com/help/en/articles/8322387-set-up-fin-ai-agent-s-multilingual-support))
- **Pricing (2026):** Essential $29/seat/mo annual ($39 monthly), Advanced $85 ($99), Expert $132+. Fin AI Agent is $0.99 per resolution. One vendor estimates multilingual setups at $30–40K/yr once translation tooling is added (vendor blog, treat as indicative). ([voiceflow](https://www.voiceflow.com/blog/intercom-pricing), [translatedesk](https://www.translatedesk.io/blog/intercom-multilingual-pricing-real-cost))
- **Platforms/SDKs:** Web Messenger, iOS/Android/React Native SDKs, REST API with Articles endpoints.
- **OSS/self-host:** No.
- **Strengths:** Tight coupling of articles to the AI agent, which is the same shape as Mocco's messenger (#95) plus help center (#96).
- **Weaknesses:** No article translation. Multilingual is gated to Advanced.
- **Recent news:** On 2026-06-15 Salesforce signed a definitive agreement to acquire Fin (formerly Intercom) for about $3.6B. Closing is expected in Salesforce's fiscal Q3 2027. ([Salesforce press release](https://www.salesforce.com/news/press-releases/2026/06/15/salesforce-signs-definitive-agreement-to-acquire-fin/), [TechCrunch](https://techcrunch.com/2026/06/15/salesforce-acquires-ai-customer-service-platform-fin-for-3-6b/)) Uncertainty about the roadmap under Salesforce gives Mocco an opening with startups that want an independent tool.

### Featurebase Help Center (deep)

- **What it is:** A feedback-board company that expanded into help center, inbox/live chat and an AI agent ("Fibi"). Its bundle overlaps heavily with Mocco's planned products (#95, #96, #98).
- **Key features:** AI-powered help center with automatic translations; a glossary whose protected terms are never translated; code snippets never translated. Translations update automatically when the base-language article is published. ([Featurebase multilingual](https://help.featurebase.app/articles/8766666-help-center-in-multiple-languages), [knowledge base](https://www.featurebase.app/features/knowledge-base))
- **Pricing (2026):** Free (1 seat, no AI), Growth $29/seat/mo, Professional $59/seat/mo (multilingual support listed here), Enterprise $99/seat/mo, all billed yearly. AI resolutions cost $0.49 each. AI translation includes 250,000 characters per workspace per month, then $0.04 per 1,000 characters. ([pricing](https://www.featurebase.app/pricing), [multilingual doc](https://help.featurebase.app/articles/8766666-help-center-in-multiple-languages))
- **Weaknesses:** How manual edits to a translation survive a source update is only hinted at in an FAQ (unverified). There is no visible per-locale review state and no deploy awareness.
- **Takeaway:** The closest product analog. Its character-metered translation with a free monthly allowance is a good pricing reference.

### GitBook (deep)

- **What it is:** A block-editor docs platform with Git sync (GitHub/GitLab), AI search/assistant and "GitBook Agent".
- **Translation:** Translation workflows ("To" language) re-run only for **pages that changed**. Translations are "a pure transformation of the source content", so **human edits to translations are not supported**. Customization goes through the glossary and AI instructions, and **changing the glossary triggers a full re-translation**. ([GitBook translations](https://gitbook.com/docs/gitbook-agent/translations))
- **Pricing (2026):** Free $0/site (1 user). Premium $65/site/mo + $12/user/mo (custom domain, AI search). Ultimate $249/site/mo + $12/user/mo (AI assistant, Agent, translations included). Enterprise is custom. On Premium, translations are an add-on: $25/mo for 50,000 words, then $0.20 per 1,000 words. ([gitbook.com/pricing](https://www.gitbook.com/pricing))
- **Strengths:** Git sync, good editor, incremental page-level re-translation.
- **Weaknesses:** No human review. Glossary edits are expensive. Per-site plus per-user pricing.

### Document360 (deep)

- **What it is:** A standalone knowledge-base SaaS (Kovai) for external and internal docs, with the Eddy AI suite.
- **Translation:** Each language is stored as its own article version, not translated live. "Translate with Eddy AI" is metered by character volume. Untranslated articles fall back to the default language. **Review reminders** flag translations when the source changes, and machine-then-human review is the recommended workflow. Crowdin integration is available. ([localization docs](https://docs.document360.com/docs/localization-getting-started), [Crowdin app](https://store.crowdin.com/document360))
- **Pricing (2026):** Quote-only. The free tier was dropped in Nov 2024. Third-party 2026 estimates: Professional about $199–249/mo, Business about $399–499/mo, Enterprise $799+/mo (unverified, from [happysupport](https://www.happysupport.ai/en/blog/document360-pricing)).
- **Strengths:** The closest to a real localization workflow among knowledge-base tools (fallback plus review reminders).
- **Weaknesses:** Sales-led pricing, and staleness works at article level rather than segment level.

### Help Scout Docs

- **What it is:** The knowledge base inside Help Scout, embedded through the Beacon widget.
- **Pricing (2026):** Free for up to 5 users, Standard $25/user/mo (Docs is +$10/user), Plus $45, Pro $75 (Docs included), all annual. Extra Docs sites cost $20/mo. AI Answers costs $0.75 per resolution. ([helpscout.com/pricing](https://www.helpscout.com/pricing/), [featurebase blog](https://www.featurebase.app/blog/helpscout-pricing))
- **Translation:** No native auto-translation or multilingual Docs workflow. Teams use a Weglot overlay or Crowdin sync. AI Assist translates only inside the editor. ([Help Scout + Crowdin](https://store.crowdin.com/helpscout), [getmacha](https://www.getmacha.com/blog/help-scout-ai-explained))

### Mintlify

- **What it is:** An MDX, git-first developer docs platform (docs.json config, folder per locale) with an AI assistant, writing agent and MCP server.
- **Pricing (2026):** Starter is free (5 editor seats, custom domain, git sync, search, no AI). Pro is $450/mo with unlimited seats, 10,000 AI credits/mo ($0.01 per overage credit) and AI translations. Enterprise is custom and includes **self-hosting** and EU hosting. ([mintlify.com/pricing](https://www.mintlify.com/pricing))
- **Translation:** Adding a locale auto-translates and keeps it synced with the main version. It is credit-metered and "the most credit-intensive" feature: about 913 credits per run, and large sites can exceed 100,000 credits (third-party estimate, [ferndesk](https://ferndesk.com/blog/mintlify-pricing)). Third-party translation vendors (Locadex/General Translation, Lingo.dev) also target Mintlify. ([Mintlify i18n guide](https://www.mintlify.com/docs/guides/internationalization), [Locadex](https://generaltranslation.com/en-US/docs/locadex/mintlify))
- **Recent news:** Reported acquisition of Trieve (search) in 2025 (unverified).

### ReadMe

- **What it is:** A developer hub for API reference plus guides, with an API playground, request logs and "Agent Owlbert" AI.
- **Pricing (2026, official page):** Starter free, Pro $250/mo annual, Enterprise custom. "Ask AI" is a $150/mo add-on on all tiers. Bi-directional git sync is available on all tiers. ([readme.com/pricing](https://readme.com/pricing)) Third-party pages still quote older $79/$349 tiers ([docsio](https://docsio.co/blog/readme-pricing)); trust the official page.
- **Translation:** Only through TMS integrations (Localize, Smartling, Transifex). No native MT.

### HelpDocs

- **What it is:** A simple flat-rate knowledge base with a WYSIWYG editor, the Lighthouse in-app widget, multilingual docs and AI drafting credits.
- **Pricing (2026):** Flat tiers of roughly $55–$199/mo with capped editor seats and add-ons for extra domains (third-party figures; see [helpdocs.io/pricing](https://www.helpdocs.io/pricing), [ferndesk review](https://ferndesk.com/blog/helpdocs-review)).
- **Weakness:** AI credits run out (ferndesk). Translation is manual per language (unverified).

### Notion-as-help-center (HelpKit, Super)

- **HelpKit:** Turns Notion pages into a help center with SEO, search, a widget and AI chat. Starter $15/mo (25 articles, 1 language, 1 seat), Business $31/mo (100 articles, 3 seats, widget, full-text search), Professional $79/mo (1,000 articles, 2 languages, 5 seats). ([HelpKit via saasworthy/G2](https://www.saasworthy.com/product/helpkit), [helpkit.so](https://www.helpkit.so/help-center-software-powered-by-notion))
- **Super.so:** A general Notion website builder. The free plan runs on a super.site subdomain; Personal is about $12/mo annual ($16 monthly) with custom domain and SEO; analytics and team seats are add-ons. ([super.so/pricing](https://super.so/pricing), [bullet.so review](https://bullet.so/blog/super-so-review/))
- **Takeaway:** Proves demand for cheap "write in the tool you already use" help centers. Language support is minimal (1–2 languages).

### Channel Talk Documents (Korean market)

- **What it is:** Channel Talk (Channel.io), the dominant Korean chat-support SaaS, ships "Documents" for guides, blogs and release notes published to the web. ALF, its AI agent, answers from Documents. "Knowledge Suggestion" proposes new or improved articles from conversation data. A Documents Open API supports custom sites. ([Documents overview](https://docs.channel.io/help/ko/articles/77e0c094-%EB%8F%84%ED%81%90%EB%A8%BC%ED%8A%B8%EB%9E%80), [channel.io/en/documents](https://channel.io/en/documents), [Documents API](https://developers.channel.io/docs/documents-open-api-welcome))
- **Pricing (2026):** Free (live chat, 30-day history). Early Stage $27/mo (3,000 managed users). Growth $90/mo (up to 1M managed users). Enterprise custom. ALF costs $0.5 per chat participation. On the Free plan Documents can hold unlimited articles but cannot publish to the web. Pricing was restructured on 2025-11-28 with ALF v2. ([channel.io/en/pricing](https://channel.io/en/pricing), [pricing notice](https://docs.channel.io/updates/ko/articles/%EC%A4%91%EC%9A%94-%EA%B3%B5%EC%A7%80-%EC%B1%84%EB%84%90%ED%86%A1-%EA%B0%80%EA%B2%A9%EC%A0%9C-%EA%B0%9C%ED%8E%B8-%EC%95%88%EB%82%B4251128--8bd5ddd0))
- **Translation:** Multilingual articles are supported. Automatic translation and staleness tracking were not found (unverified).
- **Takeaway:** Korean teams expect messenger, docs and AI in one bill. Channel Talk is the local benchmark, and Mocco's messenger plus help center pairing competes directly with it.

### OSS frameworks: Docusaurus, Fumadocs, Nextra

- **Docusaurus (Meta, MIT):** Native i18n (folder per locale, `write-translations`), native versioning, largest plugin ecosystem. Crowdin is the documented translation path. No staleness beyond what the TMS provides.
- **Fumadocs (MIT):** A Next.js/RSC docs framework with about 10.3k stars as of Jan 2026. Built-in Orama search is self-hosted in a route handler. Its default multilingual mode uses Unicode word segmentation, so CJK locales share one index without config. ([fumadocs search](https://www.fumadocs.dev/docs/headless/search/orama), [docsio review](https://docsio.co/blog/fumadocs), [comparisons](https://www.fumadocs.dev/docs/comparisons))
- **Nextra 4 (MIT):** An opinionated Next.js App Router docs theme with Pagefind search ([pkgpulse](https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026)).
- **Takeaway:** Free and developer-loved, but nothing for non-engineer editors, no hosted search API and no translation workflow. Docs-as-code sync is the bridge Mocco could offer later.

### Translation platforms (how MT plus review is done)

- **Crowdin:** Free, Pro $59/mo, Team $179/mo, Team+/Business custom. AI translation is passed through at provider API cost with no markup (OpenAI, Anthropic, Gemini, and others; 40+ MT engines). A configurable "AI Pipeline" runs quality steps (terminology, style guide, source-target alignment). Pre-translate from TM/MT, then proofread and approve. On a source update, per string, you choose "Keep translations" / "Keep approvals"; unselected strings lose their translations. An open-source project (activepieces) documented a Crowdin setup where MT auto-overwrote human translations, a concrete failure mode to design against. ([crowdin pricing](https://crowdin.com/pricing), [AI cost blog](https://crowdin.com/blog/ai-translation-cost), [file management](https://support.crowdin.com/file-management/), [activepieces #13530](https://github.com/activepieces/activepieces/issues/13530))
- **Lokalise:** Explorer $144/mo, Growth $499, Advanced $999, Enterprise custom. In 2025–2026 it moved to processed-word billing, withdrew the free plan and bundled AI translation (Standard AI/MT and Pro AI tiers). Routes across GPT-4o, Claude, DeepL and Google, and claims 80–90% of output needs no human edits. ([lokalise pricing](https://lokalise.com/pricing/), [new plans](https://docs.lokalise.com/en/articles/11694835-new-price-plans-everything-you-should-know), [locize on price changes](https://www.locize.com/blog/phrase-lokalise-price-changes-2026))
- **Phrase:** Starter about $135/mo, Team about $1,045/mo (third-party). Quality Performance Score (QPS) auto-approves MT segments above a threshold. Auto LQA was deprecated on 2026-06-30 in favor of Quality Profiles. ([Phrase Auto LQA](https://support.phrase.com/hc/en-us/articles/14313477218588-Auto-LQA-TMS), [getapp](https://www.getapp.com/website-ecommerce-software/a/memsource/))
- **Weglot:** A proxy/overlay website translator. Starter EUR 15/mo (10k words, 1 language), Business EUR 29 (50k, 3), Pro EUR 79 (200k, 5), Advanced EUR 299 (1M, 10), Extended EUR 699 (5M, 20). The word cap is a total, not a monthly refill. Every translation carries a quality tag (automatic / manual / professional), shown red or blue in the visual editor. ([weglot pricing](https://www.weglot.com/pricing), [glopal](https://merchants.glopal.com/cross-border-growth/weglot-pricing-in-2026-what-it-really-costs-to-scale), [visual editor](https://support.weglot.com/article/409-how-to-use-the-visual-editor))
- **Patterns worth copying:** segment-level translation memory (Crowdin, Lokalise), an explicit origin/quality tag per segment (Weglot), threshold-based auto-approval (Phrase QPS), keep-translation-on-source-change as an explicit choice (Crowdin), and pass-through MT cost (Crowdin).

## Feature matrix

Legend: Y = yes, P = partial/add-on, N = no, ? = unverified.

| Capability | Zendesk | Intercom | Help Scout | Document360 | GitBook | Mintlify | ReadMe | HelpDocs | Featurebase | HelpKit | Channel Talk | Docusaurus/Fumadocs | Crowdin/Lokalise |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hosted public site + custom domain | Y | Y | Y | Y | Y (Premium) | Y | Y | Y | Y | Y | Y (paid) | self-host | N/A |
| Per-locale URLs + locale switcher | Y | Y (Advanced) | P (Weglot) | Y | Y | Y | P | Y | Y | P (1–2 langs) | Y | Y | N/A |
| Automatic MT of articles | N (on-demand AI) | N | N | P (Eddy, on-demand) | Y | Y (credits) | N | ? | Y | N | ? | N | Y |
| Auto re-translate on source change | N | N | N | N (reminders) | Y (changed pages) | Y | N | N | Y | N | ? | N | Y (strings) |
| Automatic stale detection | N (manual flag) | N | N | P (review reminder) | implicit | implicit | N | N | implicit | N | ? | N | Y |
| Human edit of translation kept | Y | Y | N/A | Y | **N** | ? | N/A | Y | ? | N/A | Y | Y | Y |
| Segment-level TM (only changed paragraphs) | N | N | N | N | page-level | ? | N | N | ? | N | N | N | Y |
| Glossary / do-not-translate | P (exclusions) | N | N | ? | Y (full re-translate on change) | ? | N | ? | Y | N | ? | N | Y |
| Revision history | Y | Y | Y | Y | Y (git) | Y (git) | Y | Y | ? | Notion | ? | git | N/A |
| Search API for chat/AI | Y | Y (Fin) | Y (Beacon) | Y | Y | Y (MCP) | Y | Y | Y | P | Y (ALF) | P | N/A |
| Semantic/AI answers | Y | Y | P (add-on) | Y | Y (Ultimate) | Y (Pro) | P ($150 add-on) | P | Y | Y | Y | P | N/A |
| Docs-as-code git sync | N | N | N | N | Y | Y | Y | N | N | N | N | Y | Y |
| Open source / self-host | N | N | N | N | N | Enterprise only | N | N | N | N | N | Y | N |
| Deploy-aware review signals | N | N | N | N | N | N | N | N | N | N | N | N | N |

## Pricing comparison

| Product | Entry paid | Mid | Model | Translation cost |
|---|---|---|---|---|
| Zendesk Suite | $55/agent/mo | $115/agent/mo | per agent | AI translation needs Knowledge Pro/Ent |
| Intercom / Fin | $29/seat/mo | $85/seat/mo (multilingual) | per seat + $0.99/resolution | none native |
| Help Scout | $25/user/mo (+$10 Docs) | $45/user/mo | per user | none native |
| Featurebase | $29/seat/mo | $59/seat/mo | per seat + $0.49/resolution | 250k chars/mo free, then $0.04/1k chars |
| Document360 | ~$199/mo (quote, unverified) | ~$399/mo | quote | Eddy AI, metered by characters |
| GitBook | $65/site + $12/user | $249/site + $12/user | per site + user | $25/50k words, then $0.20/1k words (included on Ultimate) |
| Mintlify | free (no AI) | $450/mo | flat + AI credits | credit-metered, ~913 credits/run |
| ReadMe | free | $250/mo | per project | TMS integrations |
| HelpDocs | ~$55/mo | ~$199/mo | flat | ? |
| HelpKit | $15/mo | $79/mo (2 langs) | flat | none |
| Channel Talk | $27/mo | $90/mo | managed users + seats; ALF $0.5/chat | ? |
| Crowdin | $59/mo | $179/mo | hosted words | AI at provider cost |
| Lokalise | $144/mo | $499/mo | processed words | bundled |
| Weglot | EUR 15/mo | EUR 79/mo | total words x languages | bundled MT |

Cost reference for our own metering: raw LLM translation of documentation costs about $0.26–$0.57 per 1,000 words across GPT, Gemini and Claude according to Crowdin's measurements ([crowdin blog](https://crowdin.com/blog/ai-translation-cost)). Featurebase's $0.04 per 1,000 characters (about $0.20–0.25 per 1,000 words) and GitBook's $0.20 per 1,000 words therefore sit near cost, and translation is priced as a feature, not a profit center.

## Gaps and opportunities for Mocco

1. **Translation that respects human work.** GitBook forbids edits and Crowdin can overwrite approvals. A per-locale state machine (`auto` / `reviewed` / `stale`) with segment-level translation memory lets unchanged paragraphs keep their reviewed text while only changed paragraphs are machine-proposed.
2. **Automatic, explicit staleness.** Zendesk's manual "flag outdated" and Document360's reminders both rely on humans. Hashing the source revision gives exact, cheap staleness, and hashing segments tells the reviewer *which* paragraphs changed.
3. **Cheap glossary edits.** GitBook re-translates everything on a glossary change. Mocco can re-translate only the segments that contain a changed term.
4. **Deploy-aware docs freshness (unique).** Mocco knows what reached production. Articles linked to repo paths, feature flags (#101) or releases can be marked "source may be outdated" when a matching deploy is resumed and succeeds. No competitor has this signal.
5. **Messenger-native search API.** Intercom and Channel Talk win because articles feed their AI agent. Mocco's messenger (#95) can consume the same search service in-process, so the help center, messenger and AI share one index.
6. **Pricing wedge.** Suites price per agent ($55–$132/seat) and docs platforms per site ($65–$450). A workspace-level price with metered translation characters undercuts both for small multilingual teams, especially Korean teams shipping to JP/US.
7. **Open source / self-host.** Only Mintlify Enterprise and the OSS frameworks self-host. Mocco being AGPL and self-hostable is rare in this segment.

## Recommended positioning and v1 feature set

**Positioning:** "The help center that never goes stale — in any language." Write once in your source language; Mocco translates on publish, tells you exactly which paragraphs of which locales are out of date, never overwrites a human-reviewed sentence, and feeds the same content to your in-app messenger's AI.

**Table stakes (v1):**
- Collections → sections → articles, draft/published, revision history with restore
- Markdown editor with live preview and image upload
- Hosted, crawlable public site per project on a Mocco subdomain and a custom domain, per-locale URLs, locale switcher, sitemap with hreflang
- Per-locale full-text search (including CJK)
- "Was this helpful?" feedback
- Public read-only search/article API for widgets

**Differentiators (v1):**
- Automatic LLM translation on publish with Markdown structure preserved and validated (code, links, placeholders)
- Per-locale state machine: `auto`, `reviewed`, and staleness from a source hash, with segment-level diff of what changed
- Segment translation memory: reviewed text survives source edits, and only changed segments are proposed
- Glossary with do-not-translate and fixed-translation rules; a change re-translates only the affected segments
- Messenger AI consumes the same search service (#95)

**Deliberately skip (v1):**
- Semantic/AI answers on the help-center page (post-v1; embeddings reused from messenger)
- Private / logged-in articles (needs end-user identity #100)
- Docs-as-code git sync (post-v1; natural fit later)
- WYSIWYG block editor (TipTap), theme templating language, multiple brands per site
- Human translation vendor marketplace, TMS connectors (Crowdin/Lokalise import/export can come later)
- Deploy-linked staleness and optional publish gate (design hooks now, ship post-v1)

## Sources

- https://www.featurebase.app/blog/zendesk-pricing
- https://www.eesel.ai/blog/zendesk-guide-pricing
- https://support.zendesk.com/hc/en-us/articles/8717609637018-Translating-articles-in-your-help-center-using-AI
- https://support.zendesk.com/hc/en-us/articles/4408821505306-Managing-help-center-translations-for-articles
- https://developer.zendesk.com/api-reference/help_center/help-center-api/translations/
- https://community.zendesk.com/product-updates/september-2026-release-roundup-ai-and-knowledge-22401
- https://internalnote.com/whats-new-in-zendesk-ai-for-the-help-center/
- https://www.voiceflow.com/blog/intercom-pricing
- https://www.translatedesk.io/blog/intercom-multilingual-pricing-real-cost
- https://community.intercom.com/ideas/automatic-translation-of-help-center-articles-13223
- https://www.intercom.com/help/en/articles/3107405-add-translations-to-public-articles
- https://www.intercom.com/help/en/articles/8322387-set-up-fin-ai-agent-s-multilingual-support
- https://www.salesforce.com/news/press-releases/2026/06/15/salesforce-signs-definitive-agreement-to-acquire-fin/
- https://techcrunch.com/2026/06/15/salesforce-acquires-ai-customer-service-platform-fin-for-3-6b/
- https://www.helpscout.com/pricing/
- https://www.featurebase.app/blog/helpscout-pricing
- https://store.crowdin.com/helpscout
- https://www.getmacha.com/blog/help-scout-ai-explained
- https://docs.document360.com/docs/localization-getting-started
- https://store.crowdin.com/document360
- https://www.happysupport.ai/en/blog/document360-pricing
- https://gitbook.com/docs/gitbook-agent/translations
- https://www.gitbook.com/pricing
- https://www.mintlify.com/pricing
- https://www.mintlify.com/docs/guides/internationalization
- https://ferndesk.com/blog/mintlify-pricing
- https://generaltranslation.com/en-US/docs/locadex/mintlify
- https://readme.com/pricing
- https://docsio.co/blog/readme-pricing
- https://www.helpdocs.io/pricing
- https://ferndesk.com/blog/helpdocs-review
- https://www.featurebase.app/pricing
- https://help.featurebase.app/articles/8766666-help-center-in-multiple-languages
- https://www.featurebase.app/features/knowledge-base
- https://www.saasworthy.com/product/helpkit
- https://www.helpkit.so/help-center-software-powered-by-notion
- https://super.so/pricing
- https://bullet.so/blog/super-so-review/
- https://docs.channel.io/help/ko/articles/77e0c094-%EB%8F%84%ED%81%90%EB%A8%BC%ED%8A%B8%EB%9E%80
- https://channel.io/en/documents
- https://channel.io/en/pricing
- https://developers.channel.io/docs/documents-open-api-welcome
- https://www.fumadocs.dev/docs/headless/search/orama
- https://www.fumadocs.dev/docs/comparisons
- https://docsio.co/blog/fumadocs
- https://www.pkgpulse.com/guides/fumadocs-vs-nextra-v4-vs-starlight-documentation-sites-2026
- https://crowdin.com/pricing
- https://crowdin.com/blog/ai-translation-cost
- https://support.crowdin.com/file-management/
- https://github.com/activepieces/activepieces/issues/13530
- https://lokalise.com/pricing/
- https://docs.lokalise.com/en/articles/11694835-new-price-plans-everything-you-should-know
- https://www.locize.com/blog/phrase-lokalise-price-changes-2026
- https://support.phrase.com/hc/en-us/articles/14313477218588-Auto-LQA-TMS
- https://www.getapp.com/website-ecommerce-software/a/memsource/
- https://www.weglot.com/pricing
- https://merchants.glopal.com/cross-border-growth/weglot-pricing-in-2026-what-it-really-costs-to-scale
- https://support.weglot.com/article/409-how-to-use-the-visual-editor
- https://supabase.com/docs/guides/database/extensions/pgroonga
- https://pgroonga.github.io/reference/pgroonga-versus-pg-bigm.html
- https://vercel.com/docs/platforms/multi-tenant-platforms/limits
- https://strapi.io/blog/fixing-isr-revalidation-across-kubernetes-replicas-on-strapi
- https://nextjs.org/docs/13/pages/building-your-application/data-fetching/incremental-static-regeneration
