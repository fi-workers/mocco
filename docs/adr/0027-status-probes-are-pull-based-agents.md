---
title: Status probes are pull-based agents
description: Uptime checks for the status page run in one stateless agent, @mocco/probe, that leases its work from Mocco and reports results over outbound HTTPS; Mocco's hosted regions and a customer's private locations run the same agent, and Vercel functions and Cloudflare cron were rejected as probers.
type: adr
status: draft
created: 2026-10-04
updated: 2026-10-04
confidence: medium
owner: andrea
decision_date: 2026-10-04
stakeholders: [andrea]
tags: [adr, status-page, monitoring, probes, self-host]
related:
  - ./0005-tech-stack-vercel-native-next-fullstack.md
  - ./0011-external-api-surface-architecture.md
  - ./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
  - ./0028-status-pages-are-static-snapshots.md
  - ../specs/2026-09-24-status-page-design.md
  - ../research/status-page-competitors.md
---

# ADR 0027 — Status probes are pull-based agents

## Context

The status page (#103) needs monitors: HTTP(S) and TCP checks at 60-second intervals or
longer, run from several regions, with a monitor declared down only when a quorum of regions
fails for consecutive rounds. A single region's network blip must never page anyone.

Two things make the prober harder than "call a URL every minute". First, a check measures
latency and reachability **from a place**, so where the code runs is part of the result.
Second, Mocco is self-hostable on Node 22 and Postgres (ADR 0005), and teams with internal
services need checks from inside their own network, where nothing can reach in.

The app itself runs as request-scoped Vercel functions in a single region. Its background work is a Postgres job table driven by a once-a-minute tick
(ADR 0014). Neither is a place to run a long-lived, location-pinned check loop.

## Options

| Option | Multi-region | Self-host | Verdict |
|---|---|---|---|
| **Vercel Cron + regional functions** | A cron fires once, in the project's function region. Fanning out needs a deployment per region, and cold starts skew the latency being measured | No, Vercel only | Rejected as a prober. The tick stays the scheduler for evaluation, rollups and publishing |
| **Cloudflare Workers cron** | A cron runs on "a randomly selected, relatively idle edge node"; its location can't be pinned | No | Rejected for v1. A check whose location is random can't feed a per-region quorum. It could later be a "global edge" pseudo-region |
| **Push model** (Mocco calls agents) | Yes | Only with an inbound port open on the customer's side | Rejected. Private locations sit behind NAT and firewalls |
| **Pull model: one stateless agent that leases work** | Wherever it runs | Yes, the same agent | **Chosen** |

## Decision

1. **Every check runs in `@mocco/probe`**, a stateless Node 22 process in `packages/probe`
   with no database. It ships as an npm package (`npx @mocco/probe`) and a container image.
   Mocco's hosted regions and a customer's private locations run the same agent; nothing in
   the backend knows which host a location runs on.
2. **The agent pulls.** With its location token it calls `POST /api/ext/v1/probe/lease` on
   the ext app (ADR 0011) and receives the checks due in the next ~60 seconds, each with the
   monitor's spec, the round it belongs to and a lease id. It runs them at the round's time
   plus jitter, posts results to `POST /v1/probe/results`, and heartbeats its own liveness.
   Only outbound HTTPS is needed, so a private location works behind NAT.
3. **The server decides, the agent only measures.** Leasing is a `FOR UPDATE SKIP LOCKED`
   query over each monitor's `next_round_at`, one lease per location per round, so regions
   never compete for work. Result ingest is idempotent on `(lease, monitor, round,
   location)` and refuses a result that doesn't match an outstanding lease for that location,
   so a stolen token can't forge another location's results. Quorum, the up/suspect/down
   state machine and incident opening run server-side in the evaluator job (ADR 0014).
4. **A silent location is excluded, never counted as down.** A round closes when every
   leased location has reported or its timeout has passed; a missing report is `no_data`,
   which never counts toward downtime. A location that stops heartbeating drops out of
   quorum and raises an internal alert.
5. **Hosted probes are infrastructure, not code.** The hosted fleet is the same container
   deployed to small VMs, one per region. Fly.io is the first host (about 18 regions, a
   shared-cpu VM is a few dollars a month). Fly.io has no Seoul region, so a Korean location
   runs the same image on another provider. The choice of host lives in `infra/probe/`, and
   no backend code calls a hosting API.
6. **Single-node self-host can embed it.** With `STATUS_PROBE_EMBEDDED=true` the server runs
   the same lease-check-report loop in-process as one location, so a one-box install has
   monitors without running a second process.
7. **Hosted probes refuse private targets.** They resolve DNS first and block private,
   loopback, link-local and metadata ranges, checking the resolved address at connect time
   and at every redirect, so a monitor can't turn a hosted probe into a way into someone's
   network. Private locations may target private ranges; that is their purpose.

## Consequences

- A customer gets a private location with one `docker run` and two variables
  (`MOCCO_URL`, `MOCCO_PROBE_TOKEN`), and it behaves exactly like a hosted region.
- The app stays request-scoped: leases and results are short HTTP requests, which suits
  Vercel functions, and the quorum logic is ordinary server code tested on pglite.
- Mocco operates a small VM fleet outside Vercel for hosted regions. That is a cost and an
  on-call surface the rest of the product doesn't have; it is the price of measuring from
  real places.
- Lease and result traffic is about 17 requests per second at 1,000 monitors with three
  locations, served by the database the app already uses. Raw results are partitioned by
  day and dropped by partition; a `CheckResultSink` port keeps a time-series store an
  option past roughly 20,000 monitors.
- Mocco's own status page runs on a separately deployed probe set, so a Mocco outage is
  still observed by Mocco.
