---
title: Inbound webhooks use per-source ingest URLs with mandatory signatures
description: Sentry, Vercel and GitHub deliver to a per-source ingest URL whose key resolves the tenant, every request must carry a signature made with the source's sealed secret (no unverified mode), and 202 means the delivery was recorded, not delivered.
type: adr
status: draft
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
decision_date: 2026-09-25
stakeholders: [andrea]
tags: [adr, inbound, webhooks, notifications, security]
related:
  - ../reference/inbound.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
  - ./0011-external-api-surface-architecture.md
  - ./0018-domain-events-vs-audit-log.md
---

# ADR 0019 — Inbound webhooks use per-source ingest URLs with mandatory signatures

## Context

The notification relay lets a customer connect Sentry, Vercel and GitHub and get their events in
Discord. The team's prototype relay taught three things: vendors give little time and rarely retry
(Sentry expects an answer within a second and never retries; GitHub retries only by hand),
optional signature checks stay off (it ran unverified for months), and nobody could say why an event
did not arrive.

Two ways to receive the webhooks were on the table:

- **Marketplace or App installs** (a Sentry integration in their directory, a Vercel integration,
  wider scopes on the governance GitHub App). The vendor then sends a tenant id in the payload.
  Each needs a vendor review or approval, and widening the GitHub App's permissions weakens the
  read-only posture of deploy governance.
- **Customer-configured webhooks** pointed at a Mocco URL, signed with a secret the customer and
  Mocco share. Every vendor supports this today, with no review.

## Decision

1. **One ingest URL per source**: `POST /api/ext/inbound/<ingestKey>`, where the key is 32 random
   bytes (base64url) stored on `mocco_inbound_sources`. Tenant resolution is `ingest_key → source →
   workspace`, never a value inside the payload. The key is an identifier, not a credential.
2. **Signatures are mandatory.** A source cannot be saved without a secret, and there is no
   unverified mode. Sentry and Vercel show a secret the customer pastes into Mocco; for GitHub,
   Mocco generates one and shows it once. The signature is checked on the raw bytes, in constant
   time, before anything is written; a bad one is `401` with no write.
3. **Secrets are sealed** with SecretBox, bound to their row (`mocco_inbound_sources:<id>`), and
   never returned: sources on the wire carry `hasSecret`.
4. **202 means recorded.** Verify, record a receipt (deduped by the vendor's delivery id), check
   the workspace's daily quota and publish the domain event all run on the request path; delivery
   to Discord does not. An over-quota or unmapped delivery is still `202`, and its receipt says
   why. A crash after recording leaves a `pending` receipt with its payload, which a scheduled job
   republishes; the event's dedupe key is the receipt id, so a republish never publishes twice.
5. **No marketplace installs in v1.** They can be added later as another way to create a source.

## Consequences

- Customers do a few manual steps per vendor (paste a URL, copy a secret). The customer guides
  cover them with screenshots.
- A leaked ingest key alone lets nobody inject events; a leaked secret does, and rotation replaces
  it while keeping the URL.
- Receipts are the trace for "why didn't it arrive?", kept 30 days like domain events.
- The request path costs a handful of indexed queries and one AES-GCM open, which fits Sentry's
  one-second budget on a warm function.
- The GitHub App stays read-only: repository webhooks for notifications are separate from the
  governance App's webhook.
