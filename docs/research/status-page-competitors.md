---
title: Status page, monitors and incidents — competitor research
description: Market scan of uptime monitoring, incident communication and public status page tools (hosted and open source) to position Mocco's deploy-correlated status product (issue #103).
type: research
status: active
created: 2026-09-24
updated: 2026-09-24
confidence: medium
owner: andrea
tags: [research, competitors, status-page]
related:
  - ../reference/roadmap.md
  - ../specs/2026-09-24-status-page-design.md
---

# Status page, monitors and incidents — competitor research

## Summary

The market splits into three groups that rarely overlap well. Monitoring-first tools (UptimeRobot, Pingdom, Checkly, Datadog Synthetics) detect outages cheaply but treat the status page as an add-on. Communication-first tools (Atlassian Statuspage, Hund, Instatus) make good public pages but depend on something else to detect the outage. Incident-platform suites (incident.io, Rootly, FireHydrant, PagerDuty) bundle status pages into per-seat plans priced for SRE orgs. Better Stack and Instatus are the only hosted products that cover monitors, incidents and status page at a small-team price, and OpenStatus and Uptime Kuma lead open source. **No product we found correlates an incident with the deploy that caused it as a first-class object.** Some can show deploy markers if you wire up an integration, but none knows which approved run reached production, who approved it, or whether the change passed a gate. The pricing anchor for a small team is about $25 to $30 per month for 20 to 50 monitors plus one page with a custom domain (Better Stack, Instatus Pro, UptimeRobot Team, OpenStatus Starter). Statuspage still charges $99 to $399 per month for subscriber volume alone. Mocco should ship table-stakes monitors and a status page that stays up on its own, and win on deploy correlation, deploy-aware maintenance windows and a self-hostable probe agent under AGPL.

## Market map

| Segment | Players | What they sell | Mocco relevance |
|---|---|---|---|
| All-in-one monitoring + status + on-call (hosted) | Better Stack, Instatus, OpenStatus (hosted) | Monitors, incidents, status page, some on-call | Direct competitors; closest to #103 scope |
| Communication-first status pages | Atlassian Statuspage, Hund, Status.io, StatusPal | Pages, subscribers, component status; weak or no monitoring | Pricing ceiling; subscriber and audience features |
| Monitoring-first / synthetics | UptimeRobot, Pingdom (SolarWinds), Checkly, Datadog Synthetics | Probes, alerting, browser checks; status page optional | Probe feature bar (intervals, regions, check types) |
| Incident management suites | incident.io, Rootly, FireHydrant (Freshworks), PagerDuty | Incident workflow, on-call, postmortems; status page bundled | Incident model and timeline UX; per-seat pricing to undercut |
| Heartbeat / cron monitoring | Healthchecks.io (OSS), Cronitor | Dead-man switch pings for jobs | Heartbeat monitor type |
| Open source self-host | Uptime Kuma, OpenStatus, Upptime, Cachet | Free self-hosted monitors and/or pages | The self-host benchmark our AGPL build is compared against |
| Vendor status aggregation | StatusGator | Aggregates 3,600+ third-party status pages | Adjacent; "dependency status" is a later idea |
| Korea | WhaTap (URL monitoring in an APM suite), NHN Cloud / Naver Cloud monitoring (unverified) | APM-attached URL checks; no dedicated public status product found | No local status-page specialist; Korean teams use Statuspage, Instatus or Uptime Kuma |

## Competitor profiles

### Better Stack (Uptime + Status pages + On-call) — top competitor

- **What:** An observability suite (logs, traces, uptime, incident management, on-call, status pages) built from the former Better Uptime and Logtail.
- **Target:** Startups to mid-market dev teams that want one bill.
- **Key features:** HTTP(S), TCP/UDP, SSL, DNS and ping monitors down to 30 s. Heartbeat (cron) monitors. Multi-location confirmation before alerting. On-call schedules and escalation with phone and SMS. Status pages with custom domain and subscribers. Incident timelines with screenshots of the failing response.
- **Pricing (2026)** ([pricing](https://betterstack.com/pricing)): The free tier has 10 monitors and heartbeats and 1 status page. Additional monitors cost $25 per month per 50 ($21 annual), and additional heartbeats $20 per month per 10. A responder (on-call) seat is $34 per month ($29 annual). Status page add-ons: each extra public page $15 per month, custom CSS/JS $15, password protection $50, white-label $250, SSO $250, IP allowlist $250 and custom email domain $250 per page. 1,000 subscribers are included, then $40 per month per extra 1,000.
- **Platforms/SDKs:** REST API, Terraform provider, many alert integrations.
- **Open source/self-host:** No.
- **Strengths:** Broad feature set, polished UI, price is competitive at the entry point.
- **Weaknesses:** Page add-ons get expensive quickly (white-label and custom email domain each cost $250 per month per page). Deploy awareness depends on generic integrations (unverified: no native deploy-run object). Hosted only.
- **Recent news:** Continues expanding into telemetry and AI SRE features (unverified detail).

### Atlassian Statuspage — top competitor (the incumbent page)

- **What:** The best-known hosted status page. It does not monitor on its own and receives component status via API or integrations (Datadog, PagerDuty, Opsgenie, and others).
- **Target:** SaaS companies of every size, especially Atlassian shops.
- **Key features:** Components and groups, incidents with templates, scheduled maintenance, subscribers (email, SMS, webhook, Slack, Teams), system metrics display, private pages and audience-specific pages.
- **Pricing (2026)** ([pricing](https://www.atlassian.com/software/statuspage/pricing)): Public pages: Free ($0: 100 subscribers, 25 components, 2 team members, 2 metrics), Hobby $29 per month (250 subscribers), Startup $99 (1,000), Business $399 (5,000) and Enterprise $1,499 (25,000). Private pages: $79 to $1,499. Audience-specific pages start at $300 per month.
- **Open source/self-host:** No.
- **Strengths:** Brand recognition ("status.company.com" looks like Statuspage), subscriber infrastructure, Atlassian ecosystem.
- **Weaknesses:** Subscriber-tiered pricing is expensive. There are no monitors, so detection is someone else's job. The product iterates slowly, and Opsgenie's retirement has pushed Atlassian customers toward Jira Service Management (unverified that this affects Statuspage).
- **Recent news:** Atlassian is retiring Opsgenie and folding it into Jira Service Management/Compass (unverified timeline).

### Instatus — top competitor (price leader for pages + monitors)

- **What:** A fast, statically served status page with built-in monitors and on-call.
- **Target:** Startups and indie SaaS.
- **Key features:** Static page (fast, survives load), monitors at 30 s on paid plans, subscribers, custom domain, SMS/call alerts, SAML SSO on Business.
- **Pricing (2026)** ([pricing](https://instatus.com/pricing)): Starter free (15 monitors at 2 min, email alerts, 200 subscribers, no custom domain). Pro $29 per month (50 monitors at 30 s, custom domain, 5,000 subscribers). Business $99 per month (1,000 monitors, SAML SSO, 3+ custom domains, 25,000 subscribers). Enterprise custom. Annual billing saves 25%.
- **Open source/self-host:** No.
- **Strengths:** Generous subscriber limits at low prices. Its static-page architecture is the same idea as our "page stays up when you're down".
- **Weaknesses:** Its incident workflow and deploy context are shallow (unverified: no native CI/deploy correlation).

### OpenStatus (OSS) — top competitor (open-source, closest architecture)

- **What:** An open-source monitoring and status page product with a hosted cloud. The stack is a Turborepo monorepo with a Hono-on-Bun API that exposes REST/OpenAPI v1 and ConnectRPC, plus a Go checker ([infra blog](https://www.openstatus.dev/blog/openstatus-infra)).
- **Target:** Developers who want OSS and a hosted option.
- **Key features:** HTTP, TCP and DNS checks from 28 regions. Public probes run on Fly.io, Railway and Koyeb ([probes](https://www.openstatus.dev/docs/concept/probes-and-locations)). **Private locations** are an 8.5 MB Docker probe that needs only outbound 443 to the ingest endpoint ([private locations](https://www.openstatus.dev/docs/concept/private-locations)). Other features: status pages, incidents, monitoring as code.
- **Architecture notes:** Checks are scheduled through Google Cloud Tasks queues segmented by frequency (earlier it used Vercel Cron), with 3 retries. The Go checker runs on about 36 Fly instances at about $4 per probe. Storage is Turso (libSQL) for operational data and Tinybird for analytics ([infra blog](https://www.openstatus.dev/blog/openstatus-infra)). Self-hosting runs on Docker Compose with libSQL, and self-hosted probes run only as private locations ([self-host guide](https://www.openstatus.dev/docs/guides/self-hosting-openstatus)).
- **Pricing (2026)** ([pricing](https://www.openstatus.dev/pricing)): Hobby free (1 monitor at 10 min, 1 page with 3 components). Starter $30 per month (20 monitors at 1 min, 6 of 28 regions, 3-month retention). Pro $100 (50 monitors at 30 s, all 28 regions, 12 months). Scale $500 (500 components, 24 months). Extra monitors cost $15 per 10 and extra pages $20.
- **Open source:** Yes (license AGPL-3.0, unverified). About 8.8k GitHub stars.
- **Strengths:** It proves that a pull-based private probe plus a hosted region network works. It has a modern TypeScript stack much like ours.
- **Weaknesses:** Self-hosting depends on vendor services (Tinybird, Turso), and self-hosted probes are limited. The free tier is tiny. There is no deploy governance context.

### UptimeRobot — top competitor (monitoring volume leader)

- **What:** A long-standing, cheap uptime monitor with basic status pages.
- **Pricing (2026)** ([pricing](https://uptimerobot.com/pricing/)): Free (50 monitors at 5 min, 1 basic page, 3-month retention, positioned for hobby/non-profit use). Solo $108 per year (50 monitors at 60 s, 3 pages). Team $420 per year (100 monitors at 30 s, 100 pages, 3 seats). Scale from $780 per year (200 to 500 monitors at 15 s). Enterprise custom.
- **Strengths:** Huge free tier and brand familiarity. Its 15 s interval on Scale beats most competitors.
- **Weaknesses:** The incident and status page UX is basic, and there is no deploy context. The free tier is now restricted to non-commercial use (per positioning; exact ToS unverified).

### Pingdom (SolarWinds)

- **What:** A legacy synthetic uptime and RUM product.
- **Pricing (2026):** A 22-step slider with no free plan. It costs $18 per month for 10 checks, $78 for 50, $149 for 100 and $1,295 for 1,000, with about 8% off for annual billing and a 14-day trial ([Pingdom synthetic pricing](https://www.pingdom.com/synthetic-pricing/), [hyperping analysis](https://hyperping.com/blog/pingdom-pricing)).
- **Strengths:** Enterprise trust and transaction checks. **Weaknesses:** Expensive per check, dated UX, weak status page.

### Checkly

- **What:** Monitoring-as-code with Playwright browser checks, API checks and uptime monitors, driven by a CLI and TypeScript constructs.
- **Pricing (2026):** Hobby free (10 uptime monitors, 10k API runs, 1k browser runs). Starter $24 per month annual (50 uptime monitors, 4 locations). Team $64 per month annual (private locations). Overage: API runs cost $1.80 per 10k and browser runs $4 per 1k ([Checkly pricing](https://www.checklyhq.com/pricing/), [cubeapm review](https://cubeapm.com/blog/checkly-pricing-review/)).
- **Strengths:** Its checks-as-code model fits CI and deploy pipelines well, and it can run checks after a deploy. **Weaknesses:** Its status page is secondary (Checkly added status pages around 2025, unverified). Browser-run metering gets expensive.

### incident.io (status pages)

- **What:** A Slack-native incident management platform whose status pages are bundled into its plans.
- **Pricing (2026):** Team is $15 per user per month annual (+$10 for on-call), and Pro is $25 (+$20 for on-call). Enterprise is custom, around $50 per user. There is no separate status page SKU ([incident.io pricing blog](https://incident.io/blog/incident-management-pricing-comparison-2026), [spike.sh breakdown](https://spike.sh/blog/incident-io-pricing-breakdown-2026/)).
- **Features:** Public, private and internal pages. Subscribers via email, Slack and RSS. The page is updated from the incident workflow, and it alerts on traffic spikes to the page ([status pages](https://incident.io/status-pages)).
- **Strengths:** It has the best incident workflow and a page tied to real incidents. **Weaknesses:** Per-seat pricing, no probes, and deploy context only through integrations.

### Rootly

- **What:** An incident response and on-call suite with status pages.
- **Pricing:** Status pages are sold in packs of 1,000 subscribers at $1,068 per pack per year. Incident Response and On-Call each start at $20 per user per month, and Essentials contracts run $15k to $30k per year for 20 to 50 users ([Rootly pricing](https://rootly.com/pricing), [incident.io review of Rootly](https://incident.io/blog/rootly-incident-management-review-2026)).
- **Strengths:** Automation-heavy workflows. **Weaknesses:** Enterprise pricing and no monitors.

### FireHydrant (Freshworks)

- **What:** An incident management and reliability platform with a status page, a service catalog and change events. **Acquired by Freshworks**: the deal was announced in December 2025 and reportedly closed in 2026 ([FireHydrant blog](https://firehydrant.com/blog/firehydrant-to-be-acquired-by-freshworks/), [Freshworks IR](https://ir.freshworks.com/news/news-details/2025/Freshworks-to-Deepen-its-IT-Service-and-Operations-Portfolio-with-Acquisition-of-FireHydrants-AI-Native-Incident-Management-and-Reliability-Platform/default.aspx)).
- **Relevance:** FireHydrant's "change events" feed is the closest prior art to deploy correlation, but it takes generic events from integrations and has no governance.
- **Risk/opportunity:** The Freshworks ServiceOps repositioning may push developer-focused customers toward alternatives.

### PagerDuty (status pages)

- **What:** An on-call leader. External status pages are included with subscriber caps: 250 on Professional and 500 on Business. More subscribers or private/audience pages cost an add-on from about $89 per month. Seats cost $21 per responder per month (Professional) and $41 (Business), billed annually ([PagerDuty external status page docs](https://support.pagerduty.com/main/docs/external-status-page), [spike.sh breakdown](https://spike.sh/blog/pagerduty-pricing-breakdown-2026-and-how-to-save-up-to-86-percent-cost/)).
- **Weaknesses:** Expensive per seat, and the status page is an afterthought.

### Datadog Synthetics

- **What:** API and browser tests inside Datadog, sold per 10k test runs at about $5 per 10k API runs, where every location counts as a run ([openobserve analysis](https://openobserve.ai/blog/datadog-synthetic-monitoring-pricing/), [Datadog billing docs](https://docs.datadoghq.com/account_management/billing/pricing/)).
- **Relevance:** Datadog has deploy tracking via APM version tags, but no public status page.

### Uptime Kuma (OSS)

- **What:** The most popular self-hosted monitor (about 77k GitHub stars). It is a single Node app with an SQLite or MariaDB store and supports 20+ monitor types, 90+ notification providers and simple status pages. **v2.0 shipped October 20, 2025** with MariaDB support, rootless Docker and new notification providers ([heise](https://www.heise.de/en/news/Uptime-Kuma-2-0-Monitoring-tool-now-with-MariaDB-support-10793657.html), [linuxiac](https://linuxiac.com/uptime-kuma-2-0-arrives-with-mariadb-support-modern-ui-refresh/)).
- **License:** MIT.
- **Weaknesses:** It checks from a single location with no multi-region consensus, and its status page is served by the same process (it goes down with the host). It has no multi-tenant setup, no subscribers and no API-first design.

### Upptime (OSS)

- **What:** A monitor that runs on GitHub Actions. It commits response times to git, opens a GitHub issue when a site goes down and closes it on recovery, and publishes a Svelte status page to GitHub Pages. It checks every 5 minutes at best and uses about 3,000 Actions minutes per month by default ([upptime docs](https://upptime.js.org/docs/), [repo](https://github.com/upptime/upptime), about 16k stars, MIT).
- **Lesson:** A static page hosted apart from the product is loved for resilience. Treating incidents as issues is developer-native.

### Cachet (OSS)

- **What:** The classic self-hosted PHP status page. **v3.x is a rewrite (Laravel, Filament, Tailwind) still under active development**, and its docs are marked work in progress ([Cachet docs](https://docs.cachethq.io/v3.x/introduction), [GitHub](https://github.com/cachethq/cachet)). It has no built-in monitoring. BSD-3 license (unverified).

### Hund

- **What:** A hosted status page with monitors ("automated status"). It charges per page from $29 per month with 20 components included, sells component packs, and offers SSO as a flat $100 per month add-on on any plan ([Hund pricing](https://hund.io/pricing)).

### StatusGator

- **What:** Aggregates the status pages of 3,600+ third-party vendors onto one dashboard or page, and adds 1-minute website monitoring. It has a free plan, paid plans from $79 per month and flat per-account pricing ([StatusGator plans](https://statusgator.com/plans)).
- **Relevance:** "Our dependencies' status" (GitHub, Vercel, AWS) is a later add-on for Mocco. It matters to us because a deploy can fail because GitHub is down.

### Healthchecks.io (OSS) and Cronitor (heartbeats)

- **Healthchecks.io:** Hobbyist free (20 checks), Supporter $5, Business $20 (100 checks), Business Plus $80 (1,000 checks). Annual billing saves 20%, and the Business plan is free for OSS projects and nonprofits ([pricing](https://healthchecks.io/pricing/)). It is open source (BSD-3, unverified) and self-hostable (Django).
- **Cronitor:** Roughly $2 per monitor and $5 per user on Business, with Developer at $20 per month for 20 monitors (third-party sources; [cronalert compare](https://cronalert.com/compare/cronitor)). It also offers cron, heartbeat, uptime and status pages.
- **Lesson:** A heartbeat needs a unique ping URL with `/start`, `/fail` and exit-code variants, a grace period, and alerts when pings stop. Healthchecks' API shape is the de facto standard.

### Korea

- **WhaTap:** A Korean APM suite. It offers URL monitoring (browser-based checks) inside a one-stop observability product and has no dedicated public status page product ([whatap.io](https://www.whatap.io/)).
- NHN Cloud and Naver Cloud offer web service monitoring inside their cloud consoles (unverified).
- We found no Korean status-page specialist. Korean SaaS teams typically use Statuspage, Instatus or a self-hosted Uptime Kuma (unverified, anecdotal). This is an opening for a product with Korean-language page templates and KakaoTalk notifications later.

## Feature matrix

Legend: Y = yes, P = partial / add-on / via integration, N = no, ? = unverified.

| Capability | Better Stack | Statuspage | Instatus | incident.io | UptimeRobot | Pingdom | Checkly | OpenStatus | Uptime Kuma | Upptime | Cachet | Hund | Healthchecks | **Mocco v1 (planned)** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HTTP/keyword/latency monitors | Y | N | Y | N | Y | Y | Y | Y | Y | Y | N | Y | N | **Y** |
| TCP | Y | N | Y | N | Y | Y | Y | Y | Y | P | N | ? | N | **Y** |
| TLS expiry | Y | N | ? | N | Y | Y | Y | ? | Y | N | N | ? | N | **Y** |
| Heartbeat / cron | Y | N | ? | N | Y | N | Y | N | Y (push) | N | N | N | Y | **Y** |
| Multi-region consensus | Y | N | ? | N | P | Y | Y | Y | N | N | N | ? | N | **Y** |
| Self-hosted / private probe | N | N | N | N | N | N | Y (Team) | Y | Y (single) | P (Actions) | N | N | N | **Y (same agent)** |
| Browser (Playwright) checks | P | N | N | N | N | Y | Y | N | P | N | N | N | N | N (later) |
| Incidents + timeline | Y | Y | Y | Y | P | N | P | Y | P | P (issues) | Y | Y | N | **Y** |
| Postmortem | Y | Y | ? | Y | N | N | N | ? | N | N | N | ? | N | **Y (field)** |
| Scheduled maintenance | Y | Y | Y | Y | Y | Y | ? | Y | Y | N | Y | Y | N | **Y** |
| Maintenance tied to deploy/gate | N | N | N | N | N | N | N | N | N | N | N | N | N | **Y** |
| Deploy/run correlation on incident | P | P | N | P | N | N | P | N | N | N | N | N | N | **Y (native)** |
| Post-deploy check opens incident | P | N | N | P | N | N | P | N | N | N | N | N | N | **Y** |
| Status page custom domain | Y | Y (paid) | Y (Pro) | Y | Y (paid) | P | ? | Y | Y | Y | Y | Y | N | **Y** |
| Page served independent of app | Y? | Y | Y (static) | Y | ? | ? | ? | ? | N | Y | N | ? | n/a | **Y (static + CDN)** |
| Subscribers email | Y | Y | Y | Y | ? | N | ? | Y | N | N | Y | Y | n/a | **Y** |
| RSS/Atom | Y | Y | Y | Y | ? | N | ? | Y? | Y | N | Y | Y | n/a | **Y** |
| Webhook subscribers | Y | Y | Y | ? | ? | N | ? | ? | N | N | P | Y | n/a | **Y (signed)** |
| On-call / escalation | Y | N | Y | Y | N | N | N | N | N | N | N | N | N | N (later) |
| Open source | N | N | N | N | N | N | P (CLI) | Y | Y (MIT) | Y (MIT) | Y | N | Y | **Y (AGPL)** |
| Public REST API | Y | Y | Y | Y | Y | Y | Y | Y | P | N | Y | Y | Y | **Y (`/v1`)** |

## Pricing comparison

Entry-level comparison for a small SaaS team: about 20 to 50 monitors, 1 public page with custom domain, about 1,000 subscribers.

| Product | Free tier | Small-team price | Notes |
|---|---|---|---|
| Better Stack | 10 monitors, 1 page | ~$25/mo for +50 monitors; responder seats $29-34 | Page add-ons $15-$250/page each |
| Atlassian Statuspage | 100 subs, 25 components | $99/mo (1,000 subs) | No monitoring |
| Instatus | 15 monitors @2 min, 200 subs, no domain | $29/mo (50 monitors @30 s, 5,000 subs, domain) | Best page price/value |
| OpenStatus | 1 monitor, 1 page | $30/mo (20 monitors @1 min, 6 regions) | +$15 per 10 monitors |
| UptimeRobot | 50 monitors @5 min (non-commercial) | $35/mo annual Team (100 @30 s) | Basic pages |
| Pingdom | none | $18/10 checks; $78/50 | No real page |
| Checkly | 10 uptime monitors | $24/mo annual (50 uptime monitors) | Browser runs metered |
| incident.io | free tier (limited) | $15-25/user/mo | Page bundled, no probes |
| PagerDuty | n/a | $21-41/responder/mo; page add-on ~$89+ | 250-500 subs included |
| Rootly | n/a | $1,068/yr per 1,000 subs (page) + seats | Enterprise |
| Hund | trial | $29/page/mo (20 components) | SSO +$100 |
| StatusGator | free plan | from $79/mo | Vendor aggregation |
| Healthchecks.io | 20 checks | $20/mo (100 checks) | Heartbeats only; OSS |
| Cronitor | 5 monitors | $20/mo (20 monitors) | ~$2/monitor on Business |
| Datadog Synthetics | n/a | ~$5 per 10k API runs | Each location counts |
| Uptime Kuma / Upptime / Cachet | free self-host | $0 + hosting | No hosted SaaS |

## Gaps and opportunities for Mocco

1. **Deploy correlation as data.** Every competitor gets "what changed" from generic webhooks or integrations. Mocco already records the run, the pinned commit and `.mocco.yml`, who resumed which gate, and when credentials were issued. An incident can show "run #482 of `api` (commit abc123, approved by Kim at 14:02) finished 6 minutes before the first failure" without any setup.
2. **Deploy watch.** After a run succeeds, Mocco can put the monitors linked to that repo or app into a higher-frequency window, such as 30 s checks for 15 minutes. A failure in that window opens an incident that is pre-attributed to the run. Checkly and Datadog can approximate this only with CI scripts.
3. **Governed maintenance windows.** A maintenance window can open when a gated run is resumed and close when the run finishes, so the page tells customers exactly when a risky change is in flight. No competitor ties maintenance to an approval.
4. **One probe agent for hosted and self-host.** OpenStatus proves that private locations work, but its self-hosted story is weak. Uptime Kuma is single-location. Mocco can ship one AGPL probe agent. We run it in our hosted regions, and customers run it anywhere with outbound HTTPS only.
5. **Resilient page without vendor lock-in.** Pages are published as static snapshots to object storage and CDN, so the page stays up when both the customer's product and Mocco's app are down. Self-hosters get the same snapshot files and can host them on any static host.
6. **Pricing wedge.** A flat monitor-based price bundled with the Mocco workspace, with no per-seat and no per-subscriber tiers, undercuts Statuspage and the incident suites and matches Instatus and Better Stack.
7. **Korean market.** No local specialist exists. Korean and English page templates and a KakaoTalk channel (later) are cheap differentiators.

## Recommended positioning and v1 feature set

**Positioning:** "The status page that knows what you deployed." Mocco Status is uptime monitoring, incidents and a public status page with the same identity, audit log and deploy history as the rest of Mocco. It is self-hostable under AGPL with the same probe agent we run in our cloud.

### Table stakes (must ship in v1)

- HTTP(S) monitors (status code, keyword present or absent, latency threshold, TLS expiry warning), TCP monitors and heartbeat monitors with grace periods. Minimum interval 60 s (30 s during deploy watch).
- Multi-region checks with quorum consensus and confirmation rounds before an outage is declared.
- Alerts via Slack, email and signed webhook, with recovery notices and deduplication.
- Incidents: manual or monitor-created. Statuses are investigating, identified, monitoring and resolved. Incidents have a timeline of updates, affected components with impact levels, and a postmortem field.
- Scheduled maintenance windows shown on the page, with automatic start and end.
- Public page: components and groups, 90-day uptime bars, current incidents, history, custom domain, and email, RSS/Atom and webhook subscriptions.
- A public `/v1` REST API for monitors, incidents, components and heartbeat pings.

### Differentiators

- Native deploy correlation: runs promoted in the window before an incident, linked both ways.
- Deploy watch: temporary high-frequency checks after a successful run, with automatic attribution.
- Maintenance windows tied to gated runs (open on resume, close on finish).
- Audit-logged incident and page changes on the existing hash chain.
- A self-hostable probe agent (private locations) with an identical hosted network.
- A static snapshot page that stays up when Mocco is degraded.

### Deliberately skip in v1

- On-call schedules, escalation policies, phone and SMS (integrate with PagerDuty or Opsgenie-style webhooks instead).
- Playwright browser checks, multi-step API transactions, DNS/ICMP monitors.
- Automatic rollback on a failed post-deploy check (an enforcement change that needs its own ADR).
- Private or audience-specific pages, SSO-protected pages, white-label email domains.
- Third-party vendor status aggregation (StatusGator-style).
- 15 s intervals, and a public-metrics display (latency charts on the page), beyond simple uptime bars.

## Sources

- https://betterstack.com/pricing
- https://www.atlassian.com/software/statuspage/pricing
- https://instatus.com/pricing
- https://uptimerobot.com/pricing/
- https://www.openstatus.dev/pricing
- https://www.openstatus.dev/blog/openstatus-infra
- https://www.openstatus.dev/docs/concept/private-locations
- https://www.openstatus.dev/docs/concept/probes-and-locations
- https://www.openstatus.dev/docs/guides/self-hosting-openstatus
- https://incident.io/status-pages
- https://incident.io/blog/incident-management-pricing-comparison-2026
- https://spike.sh/blog/incident-io-pricing-breakdown-2026/
- https://www.checklyhq.com/pricing/
- https://cubeapm.com/blog/checkly-pricing-review/
- https://www.pingdom.com/synthetic-pricing/
- https://hyperping.com/blog/pingdom-pricing
- https://www.heise.de/en/news/Uptime-Kuma-2-0-Monitoring-tool-now-with-MariaDB-support-10793657.html
- https://linuxiac.com/uptime-kuma-2-0-arrives-with-mariadb-support-modern-ui-refresh/
- https://upptime.js.org/docs/
- https://github.com/upptime/upptime
- https://docs.cachethq.io/v3.x/introduction
- https://github.com/cachethq/cachet
- https://hund.io/pricing
- https://statusgator.com/plans
- https://support.pagerduty.com/main/docs/external-status-page
- https://spike.sh/blog/pagerduty-pricing-breakdown-2026-and-how-to-save-up-to-86-percent-cost/
- https://openobserve.ai/blog/datadog-synthetic-monitoring-pricing/
- https://docs.datadoghq.com/account_management/billing/pricing/
- https://rootly.com/pricing
- https://incident.io/blog/rootly-incident-management-review-2026
- https://firehydrant.com/blog/firehydrant-to-be-acquired-by-freshworks/
- https://ir.freshworks.com/news/news-details/2025/Freshworks-to-Deepen-its-IT-Service-and-Operations-Portfolio-with-Acquisition-of-FireHydrants-AI-Native-Incident-Management-and-Reliability-Platform/default.aspx
- https://healthchecks.io/pricing/
- https://cronalert.com/compare/cronitor
- https://www.whatap.io/
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://developers.cloudflare.com/workers/configuration/placement/
- https://docs.fly.io/about/pricing/
