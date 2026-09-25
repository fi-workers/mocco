---
title: Mocco's own alerts go through Mocco, guarded by an external stage0 heartbeat
description: The team's own Sentry, Vercel and GitHub alerts move onto Mocco's notification relay, and a stage0 canary that crosses the whole public path every 5 minutes pings an external dead-man switch only when it reaches Discord, so an outage of Mocco still alerts the team from outside.
type: adr
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
decision_date: 2026-09-25
stakeholders: [andrea]
tags: [adr, ops, notifications, monitoring, dogfooding]
related:
  - ../reference/ops-stage0.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
  - ./0019-inbound-webhooks-use-per-source-ingest-urls-with-mandatory-signatures.md
  - ./0014-background-jobs-on-a-postgres-job-table-driven-by-a-tick.md
---

# ADR 0020 — Mocco's own alerts go through Mocco, guarded by an external stage0 heartbeat

## Context

A separate relay posts the team's Sentry, Vercel and GitHub alerts to Discord today, Mocco's own
included. Mocco now has the same feature for customers (inbound sources, rules, the Discord
sender), and running two relays means the customer one is the one nobody watches. Moving the team
onto Mocco is the obvious dogfooding step.

The bootstrap problem: once Mocco carries its own alerts, an outage of Mocco (its route, its
function, its database, its job queue or its Discord sender) also silences the alert about that
outage. Sentry would still see the errors, but its alert would be delivered by the thing that is
down. Keeping the old relay only for Mocco's own alerts would keep a second system alive for the
case that matters most.

Options considered:

- **Keep the old relay for Mocco's own projects.** No bootstrap problem, but two systems forever,
  and the Mocco path is never exercised by the team's own traffic.
- **An internal health check** (a cron that queries the DB and posts "ok"). It does not cover the
  public route, the signature check or the Discord sender, and it alerts through Mocco again.
- **An external uptime probe on a health endpoint.** It proves the function answers, not that an
  event can travel from a webhook to Discord.
- **A canary through the real path, watched by an external dead-man switch.** A synthetic webhook
  enters exactly as a vendor's would and has to reach Discord; the proof of arrival is a ping to a
  service outside Mocco, which alerts on silence through its own channel.

## Decision

1. **Mocco's own alerts go through Mocco** once stage0 runs (the migration steps are in the relay
   design §11: run stage0 for a few days, recreate the routing as sources and rules, deliver to
   both for a few days, then retire the relay).
2. **Stage0 canary.** A platform schedule, `ops.stage0-canary`, every 5 minutes, POSTs a signed
   synthetic GitHub `workflow_run` success over real HTTP to the public ingest URL of a designated
   canary source on `SERVICE_DOMAIN`. It is a mapped event type, so it is recorded, published,
   fanned out by a rule to a private canary channel and sent by the Discord sender like any
   customer event. The canary deletes its message right after it posts.
3. **The heartbeat is the proof of delivery.** Only a canary delivery settled `sent` pings
   `OPS_HEARTBEAT_URL`, an external dead-man switch (healthchecks.io or similar). Nothing else
   pings it: not the job that sent the canary, not the ingest route. When pings stop, the external
   service alerts the team through its own Discord integration, outside Mocco.
4. **What the watchdog must cover:** the public route and its function, signature verification,
   the database, the job tick and queue (event fan-out and delivery jobs), and the Discord sender
   (a paused sender, a lost channel, a missing token). Breaking any of them stops the ping, and the
   external check alerts within its period plus grace (target: 15 to 20 minutes).
5. **Configured by env, off by default.** `OPS_CANARY_SOURCE_ID` and `OPS_HEARTBEAT_URL`, both
   optional; without both, no schedule is registered. Self-hosters and previews do not run it.
6. **Canaries are identified by their source**, not their content: only Mocco signs for the canary
   source, so another workspace cannot make a delivery count as a canary. Canary deliveries are
   marked so the activity trace can hide or label them.

## Consequences

- The team loses the second relay and dogfoods the customer path every 5 minutes, including the
  parts customers rarely hit (signature, dedupe, delete).
- A heartbeat service outage produces a false alarm; that is the acceptable side of a dead-man
  switch.
- An alert arrives 15 to 20 minutes after the break, not instantly. Faster detection would need a
  shorter period and grace, which costs more canaries and noise.
- The canary source gets 288 receipts a day, and its workspace sees canary deliveries in its
  trace. Both are small and marked.
- The watchdog proves the path works for the canary workspace and channel. A problem limited to
  another tenant (their channel disabled, their quota) is out of its scope, as it should be.
- Stage0 depends on `SERVICE_DOMAIN` being the public host and on the public route being reachable
  from the function itself; a deployment behind access protection must exempt the ingest route.
