---
title: Governed feature flags — competitor research
description: Market map, competitor profiles, pricing and gaps for a governed, OpenFeature-native feature flag product on Mocco (issue #101).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, feature-flags]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-feature-flags-design.md
---

# Governed feature flags — competitor research

## Summary

Feature flags are a crowded, consolidating market. In the last 18 months most independent vendors were absorbed by larger platforms: Split into Harness (2024), Eppo into Datadog (May 2025), Statsig into OpenAI (Sept 2025) and then its brand and customers into Amplitude (May 2026), and DevCycle into Dynatrace (Jan 2026). Hypertune is shutting down on 2026-08-10 and Flipt dropped its hosted cloud in Aug 2025. Observability and analytics suites now treat flags as a bundled feature, and OpenFeature has become the de facto SDK standard: Datadog, Vercel, Cloudflare, Google Cloud, Mixpanel and Octopus Deploy all launched OpenFeature-native flag services in the first half of 2026. The governance gap is still open. Approval workflows (change requests, N approvers, separation of duties) and a durable audit log sit behind enterprise or high tiers almost everywhere: LaunchDarkly Enterprise, Unleash Enterprise at $75/seat, Flagsmith Scale-Up at $250/mo, GrowthBook Enterprise, Statsig Pro at $150/mo. Where they exist, they are generic "four-eyes" flows with weak kill-switch semantics. Unleash, for example, routes a kill through the same change request unless the user holds a "skip change requests" permission. No competitor ties a flag change to the deploy pipeline, the approving roles and a tamper-evident audit chain in one place. Mocco should sell governance as the product, not an upsell. It should ship an OpenFeature-first, flagd-compatible ruleset so adoption and exit are both a provider swap, and make approvals, audit and self-hosting available at every tier.

## Market map

| Segment | Players | Buying center |
|---|---|---|
| Enterprise feature management | LaunchDarkly, Harness FME (Split), Optimizely Feature Experimentation | Platform/release engineering, large orgs, compliance-driven |
| Experimentation-first (flags are the delivery vehicle for A/B tests) | Statsig (Amplitude), Eppo (Datadog), GrowthBook, Optimizely, Hackle | Product/data teams |
| Open-source / self-hostable flag servers | Unleash, Flagsmith, GrowthBook, Flipt, flagd (+ GO Feature Flag) | Developers, regulated/on-prem, cost-sensitive |
| Flags bundled into a broader dev/product suite | PostHog, Datadog Feature Flags, DevCycle (Dynatrace), Vercel Flags, Firebase Remote Config | Teams already on the suite |
| Developer-experience / typed flags | Hypertune (sunsetting), Vercel Flags SDK, ConfigCat | Frontend/full-stack developers |
| Standards layer | OpenFeature (CNCF) SDKs, OFREP, flagd | Everyone; vendor-neutral integration point |
| Korean market | Hackle (experimentation + CRM + flags), Firebase Remote Config (dominant in mobile) | Korean product/growth teams |

## Competitor profiles

### LaunchDarkly (deep)

- **What it is:** The category leader in feature management, now a broader "release, observability, AI config" platform.
- **Target:** Mid-market to enterprise engineering orgs.
- **Key features:** Flags with multi-variate types, contexts (multi-kind targeting), segments, percentage rollouts, scheduled changes, release pipelines (multi-step release workflows), guarded rollouts with auto-rollback, experimentation, AI Configs, code references (`ld-find-code-refs`) for stale-flag cleanup, flag triggers. Streaming (SSE) updates, relay proxy for self-hosted edge.
- **Governance:** Approval requests on specific environments, reviewers notified via email/Slack/Teams. Approvals, scheduled flag changes, multi-step release workflows and the audit log are **Enterprise-only** ([pricing](https://launchdarkly.com/pricing/), [approvals docs](https://launchdarkly.com/docs/home/releases/approvals)). Minimum-approver counts, a "bypass approvals" permission and ServiceNow change-management integration exist (unverified: exact semantics per plan).
- **Pricing (2026):** Developer $0 (unlimited seats, 5 service connections, 1K client-side MAU, no approvals, no audit log). Foundation is pay-as-you-go at $10/service connection/mo and $8.33 per 1K client-side MAU/mo billed yearly, still without approvals or audit log. Enterprise is custom ([pricing](https://launchdarkly.com/pricing/)).
- **Platforms/SDKs:** 25+ server/client/edge SDKs (unverified count), including React Native, edge SDKs (Vercel, Cloudflare, Akamai), and OpenFeature providers.
- **OSS/self-host:** SDKs are open source; the server is SaaS-only (Relay Proxy is self-hostable, but the control plane is not). A federal/FedRAMP instance exists.
- **Strengths:** Maturity, breadth, streaming architecture, release pipelines, enterprise trust.
- **Weaknesses:** Expensive. Governance is paywalled at Enterprise. The pricing units (service connections plus MAU) are hard to predict. No self-hosting.
- **Recent news:** Expanded into observability (session replay, errors, logs and traces bundled in the free tier) and AI runs ([pricing](https://launchdarkly.com/pricing/)); acquisition of Highlight.io in 2025 (unverified).

### Unleash (deep, OSS)

- **What it is:** The most widely used open-source feature flag server (Node/TypeScript + Postgres), with a commercial Enterprise edition.
- **Target:** Developers and regulated orgs that want self-hosting. Strong in Europe.
- **Key features:** Activation strategies (gradual rollout with stickiness, user IDs, IPs, hostnames, custom constraints), variants, segments, projects and environments, Unleash Edge (Rust edge/proxy for client-side and scale), lifecycle and "technical debt" views with stale flags, and impression data.
- **Governance:** Change requests are **Enterprise-only**. They are per environment, with up to 10 required approvals and scheduling. Admins can approve and apply their own changes. A "skip change requests" permission bypasses environment-level actions, and there is no dedicated kill-switch bypass: disabling follows the same approval flow ([docs](https://docs.getunleash.io/reference/change-requests)). Audit logs with 2-year retention are paid-only.
- **Pricing (2026):** Open Source is free and self-hosted, limited to 1 project, 2 environments and 5,000 flags per instance. Pay-as-you-go is $75/seat/mo (5-seat minimum self-hosted). Enterprise is a custom annual contract ([pricing](https://www.getunleash.io/pricing)).
- **Platforms/SDKs:** 15+ server SDKs, plus frontend SDKs (JS, React, Vue, Svelte, iOS, Android, Flutter, React Native via proxy/Edge) and OpenFeature providers (Angular via the Unleash web provider, per the [OpenFeature mid-2026 update](https://openfeature.dev/blog/openfeature-mid-2026-update/)).
- **Strengths:** Proven OSS, Postgres-based (same stack as Mocco), a good local-evaluation model (server SDKs poll the ruleset, client SDKs go through Edge/Frontend API).
- **Weaknesses:** Governance and audit paywalled. The OSS tier is deliberately capped (1 project, 2 environments). Seat pricing is steep.

### Flagsmith (deep, OSS)

- **What it is:** An open-source (BSD-3) flag and remote config server (Django + Postgres), with SaaS, private cloud and on-prem options.
- **Target:** SMB to enterprise, with strong self-hosted and regulated adoption.
- **Key features:** Flags with remote config values, identities and traits, segments, multivariate rollouts, scheduled flags, an Edge Proxy, local-evaluation server SDKs, an OpenFeature provider, and a real-time flag updates add-on.
- **Governance:** Roles, permissions, **change requests** and audit logs start at **Scale-Up** ($250/mo yearly) ([pricing](https://www.flagsmith.com/pricing)).
- **Pricing (2026):** Free: 50K API requests/mo, 1 member. Start-Up: $40/mo yearly, 1M requests, 3 members. Scale-Up: $250/mo yearly, 5M+ requests, 5 members, $50/member up to 20. Enterprise: custom, including self-hosted ([pricing](https://www.flagsmith.com/pricing)).
- **Platforms/SDKs:** 15+ SDKs, including React Native and Flutter.
- **Strengths:** Genuinely open source with self-hosting, remote config, and change requests at a mid-tier price.
- **Weaknesses:** Request-based pricing penalizes client-heavy apps. The approval model is basic, with no N-of-M across roles.
- **Recent news:** Published market commentary on OpenAI/Statsig ([blog](https://www.flagsmith.com/blog/why-openai-acquired-statsig)).

### GrowthBook (deep, OSS)

- **What it is:** An open-source (MIT core, with enterprise directories) experimentation and feature flag platform that is warehouse-native.
- **Target:** Product/data teams that want A/B testing on their own warehouse, and developers who want free flags.
- **Key features:** Flags with targeting, rollouts, prerequisites, safe rollouts, multi-arm bandits, a visual editor, and SDKs that evaluate locally from a JSON "features" payload served via CDN (SSE streaming via GrowthBook Proxy).
- **Governance:** Approval workflows, custom environments, ramp schedules, and exportable audit logs are **Enterprise** ([pricing](https://www.growthbook.io/pricing)).
- **Pricing (2026):** Cloud Starter is free (3 users, 1 project, 1M CDN requests). Pro is $40/seat/mo (up to 30 users, 2M CDN requests then $10/M, 20 GB bandwidth then $1/GB). Enterprise is custom. Self-hosted OSS is free with unlimited users ([pricing](https://www.growthbook.io/pricing)).
- **Platforms/SDKs:** 20+ SDKs including React Native, and a tiny JS SDK (unverified size).
- **Strengths:** A free, unlimited OSS self-host. Its CDN-cached JSON payload plus local evaluation is the closest analogue to what Mocco needs.
- **Weaknesses:** Governance paywalled. Flags are secondary to experimentation.

### Statsig (deep; OpenAI then Amplitude)

- **What it is:** An experimentation, flags and product analytics platform.
- **Recent news:** OpenAI acquired Statsig on 2025-09-02 for about $1.1B in stock, and CEO Vijaye Raji became OpenAI's CTO of Applications ([CNBC](https://www.cnbc.com/2025/09/02/openai-buys-statsig-for-1point1-billion-hires-ceo-as-applications-exec.html), [OpenAI](https://openai.com/index/vijaye-raji-to-become-cto-of-applications-with-acquisition-of-statsig/)). On 2026-05-05 **Amplitude took over the Statsig brand, platform and customers** while the original team stayed at OpenAI ([Amplitude](https://amplitude.com/blog/amplitude-and-statsig-partnership), [MarTech](https://martech.org/amplitude-and-statsig-deal-raises-questions-for-customers/)). This leaves customers with continuity concerns, which is a migration opportunity.
- **Pricing (2026):** Developer is free (2M metered events, unlimited seats, free flag checks, no approvals or audit). Pro is $150/mo with 5M events then $0.05/1K and includes approvals and audit log. Enterprise is custom ([pricing](https://www.statsig.com/pricing)).
- **Strengths:** Flag checks are free, with strong stats and warehouse-native options.
- **Weaknesses:** Ownership turmoil and an analytics-centric model. Governance starts at a paid tier.

### PostHog feature flags

- **What it is:** Flags bundled in the open-source (MIT core) product OS: analytics, replay, experiments, surveys.
- **Pricing:** First 1M flag requests/mo free, then $0.0001/request (1–2M), $0.000045 (2–10M), down to about $0.00001 at 50M+ ([flexprice](https://flexprice.io/blog/posthog-pricing-guide), [PostHog](https://posthog.com/feature-flags)).
- **Features:** Local evaluation for server SDKs, early-access management, multivariate, and payloads. Approval/change-request workflows for flags are not evident (unverified).
- **Self-host:** Hobby deployment is open source. Scale is SaaS-first.
- **Take:** Great for PostHog users, but not a governance tool.

### ConfigCat

- **What it is:** A Hungarian SaaS for flags and remote config, known for simple pricing with unlimited seats and MAUs.
- **Pricing (2026):** Forever Free: 10 flags, 2 environments, 5M config JSON downloads/mo. Pro: $110/mo, 100 flags, 3 environments, 25M downloads. Smart: $325/mo, unlimited, 250M downloads. Enterprise: $900/mo, 1B downloads, 2-year audit retention. Dedicated: $4,500/mo ([pricing](https://configcat.com/pricing/)).
- **Features:** Local evaluation from a config JSON, a self-hosted proxy, on-prem options, and audit logs on every plan (35-day retention below Enterprise).
- **Take:** Charging per config download (not per evaluation) is the fairest unit. Approval workflows are limited (unverified).

### Harness FME (formerly Split)

- **What it is:** Split was acquired by Harness (closed 2024-06-11) and rebranded Feature Management & Experimentation. Standalone pricing is gone: FME is contact-sales inside Harness Enterprise, in the five-to-six-figure range ([abtesting.cc](https://abtesting.cc/blog/harness-fme-pricing/), [Harness](https://www.harness.io/products/feature-management-experimentation)).
- **Take:** FME integrates flags with Harness pipelines and OPA policies, making it the closest to "flags governed by the deploy pipeline". It is enterprise-only and heavy.

### DevCycle (Dynatrace)

- **What it is:** The first "OpenFeature-native" flag platform, built by OpenFeature governance board members. Acquired by **Dynatrace** (announced 2026-01-13) ([Dynatrace](https://www.dynatrace.com/news/blog/dynatrace-acquires-devcycle-to-strengthen-feature-delivery/)).
- **Pricing:** Free Forever (unlimited seats and flags, 1K client MAU, 100K server config requests). Developer is usage-based from $10/mo. Business is $500/mo with roles and permissions ([DevCycle](https://devcycle.com/pricing)).
- **Tech:** Edge-evaluated flags and local-bucketing server SDKs compiled from a shared WASM core (unverified), plus an MCP server.
- **Take:** DevCycle validates the OpenFeature-native positioning. Its move into Dynatrace leaves the independent, developer-first OpenFeature slot open.

### Optimizely Feature Experimentation

- **What it is:** An enterprise experimentation suite. The free **Rollouts** plan includes flags and one A/B test. Paid plans have no list price, with a reported median of about $81K/yr ([Optimizely](https://www.optimizely.com/products/feature-experimentation/free-feature-flagging/), [Kirro](https://kirro.io/optimizely-pricing)).
- **Take:** Experimentation buyers, not a governance competitor.

### Flipt (OSS, git-native)

- **What it is:** An open-source (GPL-3.0 for v2, unverified) Go flag server. **v2 is git-native**: flags live in your own Git repos (GitHub/GitLab/Bitbucket/Azure DevOps/Gitea), with branch-based environments, real-time streaming, and REST + gRPC plus OpenFeature. Flipt Pro adds advanced workflows, GPG commit signing and secrets. **Hosted Flipt Cloud was discontinued in Aug 2025** ([GitHub](https://github.com/flipt-io/flipt), [gappsy](https://www.gappsy.com/tools/flipt/)).
- **Take:** Flipt is the strongest flags-as-code reference, but it pushes governance entirely onto Git review, so "can merge = can release". That is exactly the gap Mocco's thesis (write is not release) targets.

### Vercel Flags / Flags SDK

- **What it is:** The Flags SDK (`flags` npm, open source) is a framework-native flag-definition library for Next.js/SvelteKit with adapters (LaunchDarkly, Statsig, Edge Config, OpenFeature, and others). It integrates with the Flags Explorer toolbar. **Vercel Flags** is a first-party flag service in public beta, with a dashboard, targeting rules, segments and environments ([changelog](https://vercel.com/changelog/vercel-flags-is-now-in-public-beta)).
- **Pricing/limits:** Hobby includes 10K flag requests/mo. Pro is $0.03 per 1K flag requests, where one request reading config counts once however many flags it evaluates. Up to 10K flags, 10 environments per flag, and a 10 MB total pack synced to the edge ([docs](https://vercel.com/docs/flags/vercel-flags/limits-and-pricing)).
- **Take:** A Mocco OpenFeature provider plugs into the Flags SDK through its OpenFeature adapter at no extra cost. Vercel Flags has no approval workflow (unverified).

### OpenFeature + flagd (standard)

- **What it is:** A CNCF project defining a vendor-neutral evaluation API, provider interface, hooks, events and evaluation context. **Spec v0.9.0** (2026) stabilizes evaluation and providers. **OFREP** (remote evaluation protocol) v0.3.0 added SSE event streams and ADRs for push, cache-first persistence and disabling default polling, but SSE is unimplemented in six ecosystems ([OpenFeature mid-2026](https://openfeature.dev/blog/openfeature-mid-2026-update/), [OFREP](https://openfeature.dev/docs/reference/other-technologies/ofrep/)).
- **flagd:** A reference daemon plus in-process providers that read a JSON flag definition. Targeting uses JsonLogic. `fractional` rollouts use **MurmurHash3** over `flagKey + targetingKey` by default, normalized to [0,100], with relative weights and an overridable bucketing expression, so all in-process implementations bucket identically ([fractional spec](https://flagd.dev/reference/specifications/custom-operations/fractional-operation-spec/)). flagd 0.16.x added custom sync headers and incremental gRPC updates.
- **Take:** Emitting flagd-compatible rulesets and exposing an OFREP endpoint gives Mocco instant SDK coverage across about 10 languages, including clients it never wrote.

### Hypertune (sunsetting)

- **What it is:** Type-safe, Git-based flags with code generation. **It is shutting down on 2026-08-10** and no longer accepts sign-ups ([Hypertune](https://www.hypertune.com/pricing)).
- **Take:** Its users are stranded, and they valued type-safety and codegen, which Mocco can offer through a `mocco flags codegen` CLI.

### Eppo (Datadog)

- **What it is:** A warehouse-native experimentation platform with flags. **Datadog acquired it on 2025-05-05** (reportedly about $220M) and now sells it as "Eppo by Datadog" alongside Datadog Feature Flags ([TechCrunch](https://techcrunch.com/2025/05/05/datadog-acquires-eppo-a-feature-flagging-and-experimentation-platform/)).
- **Datadog Feature Flags pricing:** The first 1M Monthly Flag Configuration Requests (MFCR, one fetch of the rules file, not per evaluation) are free, then $55 per million ([Datadog docs](https://docs.datadoghq.com/feature_flags/guide/estimating_and_managing_costs/)).
- **Take:** It validates "bill per ruleset fetch, evaluate locally", and flags are becoming an observability add-on.

### Hackle (Korea)

- **What it is:** A Korean all-in-one growth platform: A/B testing, product analytics, CRM messaging, feature flags and remote config.
- **Pricing:** Growth is 200,000 KRW/mo base plus usage, up to 5M events/mo, 10 members, flags and remote config included. Enterprise is custom ([Hackle](https://hackle.io/en/pricing)).
- **Take:** It is sold to growth/marketing teams, and its flag governance is not a selling point (unverified). Korean teams choosing between Hackle, Firebase and LaunchDarkly have no governed, developer-first option.

### Firebase Remote Config

- **What it is:** Google's mobile-first remote config, with rollouts, personalization and A/B testing. It is the default for Korean mobile apps (unverified market share).
- **Recent news:** **Paid since 2026-09-01.** The no-cost plan allows 100K fetches/day/project, then $0.06 per 10K requests, falling to $0.01 per 10K beyond 10M/day. There is a limit of 24 running experiments plus rollouts ([Firebase](https://firebase.google.com/docs/remote-config/pricing), [Heroic Labs](https://heroiclabs.com/blog/firebase-remote-config-pricing/index.html)).
- **Take:** This pricing change pushes mobile teams to re-evaluate right now. It has no approvals, and its audit is limited to template version history.

## Feature matrix

Legend: Y = yes, P = paid/enterprise tier only, L = limited, N = no, ? = unverified.

| Capability | LaunchDarkly | Unleash | Flagsmith | GrowthBook | Statsig | PostHog | ConfigCat | Harness FME | DevCycle | Flipt v2 | Vercel Flags | flagd | Firebase RC | Hackle |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Self-host control plane | N | Y | P | Y | N | L | L (proxy) | N | N | Y | N | Y | N | N |
| OSS server | N | Y (capped) | Y | Y | N | Y | N | N | N | Y | N | Y | N | N |
| OpenFeature provider | Y | Y | Y | Y | Y | Y | Y | Y | Y (native) | Y | Y | Y (native) | ? | ? |
| Local (in-process) eval, server | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? |
| Streaming updates | Y | L (Edge) | P (add-on) | Y (proxy) | ? | N | N | Y | Y | Y | Y | Y | Y (real-time) | ? |
| Environments | Y | Y (2 in OSS) | Y | P (custom) | Y | L | Y | Y | Y | Y (branches) | Y | N/A | N | ? |
| Approvals / change requests | P | P | P | P | P | N? | N? | P | ? | via Git PR | N? | N | N | ? |
| N-of-M across distinct roles | N? | N (count only) | N | N | N | N | N | via pipelines? | N | via CODEOWNERS | N | N | N | N |
| Kill switch bypasses approval | ? | N (permission-based skip) | ? | ? | ? | N/A | N/A | ? | ? | N (it is a commit) | N/A | N/A | N/A | N/A |
| Tamper-evident audit chain | N | N | N | N | N | N | N | N | N | Git history | N | N | N | N |
| Audit log on free tier | N | N | N | N | N | Y? | Y (35d) | N | ? | Git | ? | N | L | ? |
| Flags-as-code | Terraform | Terraform | Terraform | API | API | API | Terraform | Terraform | CLI | Native | Flags SDK (code defs) | Native (files) | Templates | N |
| Stale-flag detection | Y (code refs) | Y | L | L | Y | L | L (zombie flags) | Y | Y | N? | N? | N | N | N |
| Tied to deploy pipeline / what reached prod | L (release pipelines) | N | N | N | N | N | N | Y (Harness CD) | L (Dynatrace) | L (Git) | L (Vercel deploys) | N | N | N |
| React Native | Y | Y | Y | Y | Y | Y | Y | Y | Y | ? | via OpenFeature | via OFREP | Y | Y |

## Pricing comparison

| Vendor | Free tier | Entry paid | Governance (approvals + audit) available at | Unit |
|---|---|---|---|---|
| LaunchDarkly | 5 service connections, 1K client MAU | Foundation: $10/service connection + $8.33/1K MAU | Enterprise (custom) | Service connections + client MAU |
| Unleash | OSS self-host (1 project, 2 environments) | $75/seat/mo | Enterprise | Seat |
| Flagsmith | 50K requests, 1 member | $40/mo (1M requests) | Scale-Up $250/mo | API requests + seats |
| GrowthBook | Free cloud (3 users), OSS unlimited | $40/seat/mo | Enterprise | Seat + CDN requests |
| Statsig | 2M events | $150/mo | Pro $150/mo | Metered events (flag checks free) |
| PostHog | 1M flag requests/mo | $0.0001/request, tiered down | Not a flag feature (unverified) | Flag request |
| ConfigCat | 10 flags, 5M downloads | $110/mo | Audit on all tiers, 2-year at $900/mo | Config JSON downloads |
| Harness FME | None public | Contact sales | Enterprise | MAU (contract) |
| DevCycle | 1K client MAU, 100K server requests | $10/mo usage | Business $500/mo (roles) | MAU + config requests |
| Optimizely | Rollouts (free flags + 1 test) | ~$26K–$261K/yr | Enterprise | Contract |
| Flipt | OSS free, unlimited | Pro (quote) | Via Git / Enterprise | Support contract |
| Vercel Flags | Hobby: 10K flag requests/mo | Pro: $0.03/1K requests | N/A | Flag request (per config read) |
| Datadog FF (Eppo) | 1M MFCR/mo | $55/M MFCR | Datadog RBAC/audit (unverified) | Ruleset fetch |
| Firebase RC | 100K fetches/day | $0.06/10K fetches | None | Fetch |
| Hackle | None | 200,000 KRW/mo + usage | Unverified | Events |

## Gaps and opportunities for Mocco

1. **Governance is paywalled everywhere.** Approvals and audit start at $150–$250/mo at best and usually require Enterprise contracts. Mocco can include gates and the audit chain on every tier and in AGPL self-host, because governance is its core, not an upsell.
2. **Approval models are shallow.** Competitors offer "N approvers" or admin self-approval (Unleash admins can approve their own changes). None offers N-of-M AND across roles with distinct-principal matching, `prevent_self` and `reason_required`, and Mocco already has that in `evaluateGate`.
3. **Kill-switch semantics are unprincipled.** Emergency disable either goes through the same change request or relies on a blanket "skip" permission. Mocco can define a narrow safety-direction bypass: only "serve the declared off variant" skips the gate, it is always audited, and restoring is gated.
4. **"Can merge = can release" in flags-as-code.** Flipt v2 and file-based flagd make Git review the only control. Mocco can accept flags-as-code while keeping "GitHub write is not release": a merge produces a changeset that still needs the gate on protected targets.
5. **No one correlates flags with deploys.** Mocco knows which commit reached production and who approved it. It can show flag changes and deploys on one timeline, block turning on a flag whose code has not reached that target, and feed incidents (#103).
6. **Consolidation churn.** Statsig (Amplitude), DevCycle (Dynatrace), Eppo (Datadog), Split (Harness), the Hypertune shutdown, the loss of Flipt Cloud, and Firebase Remote Config becoming paid all create switching customers. An OpenFeature-first vendor makes that switch cheap.
7. **OpenFeature interop as distribution.** A flagd-compatible ruleset plus an OFREP endpoint means any OpenFeature SDK (10+ languages) works with Mocco on day one. Mocco only needs to hand-write JS/TS providers.
8. **Korean market.** Hackle and Firebase dominate, and neither is developer-governance oriented. A governed, self-hostable option with Korean-friendly docs is uncontested.

## Recommended positioning and v1 feature set

**Positioning:** "Feature flags where a production flip is a governed change. OpenFeature SDKs, approvals on every plan, a tamper-evident audit, self-hostable." The product is for teams that already see a flag flip as a release, and for regulated teams, such as healthcare, fintech and Korean enterprise, who need to answer "who turned this on, why, and who approved it".

**Table stakes (v1 must have):**
- Boolean, string, number and JSON flags with variants, and a per-target default and off variant.
- Targeting rules on context attributes, segments, and a percentage rollout with deterministic hashing on a stable key.
- Server-side local evaluation from an ETag'd ruleset. Client-side (web/RN) bulk remote evaluation with cache-first offline defaults. Polling plus SSE streaming.
- OpenFeature providers for Node server, web and React Native. React hooks via `@openfeature/react-sdk`.
- Environments (named evaluation targets) with SDK keys. Diff view, history and rollback.
- Stale-flag detection from evaluation telemetry.

**Differentiators:**
- Gate-governed changes on protected targets that reuse Mocco roles, N-of-M distinct principals, `prevent_self`, `reason_required`, and approvals bound to a changeset hash.
- Kill switch with a principled bypass: one-way to the declared off variant, audited, with a gated restore.
- Every flag change lands in the same hash-chained audit log as deploys, gates and credentials.
- Flags-as-code (`.mocco/flags.yml`), where a merge becomes a changeset and still passes the gate.
- flagd-compatible ruleset and OFREP endpoint, so any OpenFeature SDK works and exit is a config change.
- Deploy correlation: a flag timeline alongside runs, plus a "code not yet deployed to this target" warning (v1.5).
- Governance on every tier and in AGPL self-host, with permissively licensed SDKs.

**Deliberately skip in v1:**
- Experimentation statistics, metrics and warehouse-native analysis. Emit OpenFeature tracking/exposure hooks only.
- Scheduled changes and multi-step release pipelines (a later slice can reuse the scheduler foundation).
- A visual editor, AI configs, and auto-rollback on metrics.
- Hand-written SDKs beyond JS/TS. Other languages use flagd in-process providers or OFREP.
- Edge-worker-specific SDKs (Cloudflare/Akamai). The Vercel Flags SDK works via its OpenFeature adapter.
- A Terraform provider and public management API. The UI, tRPC and repo file cover v1.

## Sources

- https://launchdarkly.com/pricing/
- https://launchdarkly.com/docs/home/releases/approvals
- https://www.getunleash.io/pricing
- https://docs.getunleash.io/reference/change-requests
- https://www.flagsmith.com/pricing
- https://www.flagsmith.com/blog/why-openai-acquired-statsig
- https://www.growthbook.io/pricing
- https://www.statsig.com/pricing
- https://www.cnbc.com/2025/09/02/openai-buys-statsig-for-1point1-billion-hires-ceo-as-applications-exec.html
- https://openai.com/index/vijaye-raji-to-become-cto-of-applications-with-acquisition-of-statsig/
- https://www.statsig.com/blog/openai-acquisition
- https://amplitude.com/blog/amplitude-and-statsig-partnership
- https://martech.org/amplitude-and-statsig-deal-raises-questions-for-customers/
- https://posthog.com/feature-flags
- https://flexprice.io/blog/posthog-pricing-guide
- https://configcat.com/pricing/
- https://abtesting.cc/blog/harness-fme-pricing/
- https://www.harness.io/products/feature-management-experimentation
- https://devcycle.com/pricing
- https://www.dynatrace.com/news/blog/dynatrace-acquires-devcycle-to-strengthen-feature-delivery/
- https://www.optimizely.com/products/feature-experimentation/free-feature-flagging/
- https://kirro.io/optimizely-pricing
- https://github.com/flipt-io/flipt
- https://www.gappsy.com/tools/flipt/
- https://vercel.com/changelog/vercel-flags-is-now-in-public-beta
- https://vercel.com/docs/flags/vercel-flags/limits-and-pricing
- https://openfeature.dev/blog/openfeature-mid-2026-update/
- https://openfeature.dev/docs/reference/other-technologies/ofrep/
- https://flagd.dev/reference/specifications/custom-operations/fractional-operation-spec/
- https://github.com/open-feature/flagd
- https://www.hypertune.com/pricing
- https://techcrunch.com/2025/05/05/datadog-acquires-eppo-a-feature-flagging-and-experimentation-platform/
- https://docs.datadoghq.com/feature_flags/guide/estimating_and_managing_costs/
- https://hackle.io/en/pricing
- https://firebase.google.com/docs/remote-config/pricing
- https://heroiclabs.com/blog/firebase-remote-config-pricing/index.html
