---
title: Domain events
description: The domain event catalog, how to publish and subscribe, delivery semantics (at-least-once, per-subscriber jobs, dedupe keys), retention, and the governance events with their payloads.
type: reference
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [reference, events, jobs, backend, notifications]
related:
  - ../adr/0018-domain-events-vs-audit-log.md
  - ./jobs.md
  - ./backend-conventions.md
  - ../superpowers/specs/2026-09-25-notification-relay-design.md
code_refs:
  - packages/common/src/events.ts
  - packages/backend/src/domain/events/EventBus.ts
  - packages/backend/src/domain/events/jobs.ts
  - packages/backend/src/domain/events/ports.ts
  - packages/backend/src/domain/events/subscriptions.ts
  - packages/backend/src/domain/events/instance.ts
  - packages/backend/src/domain/events/repos/domain-event.repo.ts
  - packages/backend/src/domain/execution/run-event-subject.ts
  - packages/backend/src/runtime/jobs.ts
---

# Domain events

A domain event is a fact one domain publishes for others to react to. It is stored in
`mocco_domain_events`, fanned out to subscribers through the job queue, and pruned after 30 days.
It is not the audit log (the compliance record, kept forever) and not a run event (one run's
timeline). The decision is [ADR 0018](../adr/0018-domain-events-vs-audit-log.md).

## Catalog

Every type has one zod payload schema in `@mocco/common/events` (`domainEventPayloadSchemas`).
`DomainEventTypes` holds the names; reference them, never a raw string.

| Type | Published by | Subject |
|---|---|---|
| `run.succeeded` | `RunService`, when the last item finishes | `run` / run id |
| `run.failed` | `RunService`, when a step fails or its executor is unknown | `run` / run id |
| `gate.pending` | `RunService`, when a run pauses at a gate | `run_gate` / gate id |
| `gate.resumed` | `GateService`, when the votes satisfy the gate | `run_gate` / gate id |
| `gate.rejected` | `GateService`, on a reject vote | `run_gate` / gate id |

A gate reject ends the run in `rejected`; it publishes `gate.rejected` only, not `run.failed`.

### Governance payloads

Every governance payload names its run so a notification can render without another query:

```ts
{
  workspaceId, runId,
  repoFullName,      // "owner/name"
  pipelineName,      // .mocco.yml `pipeline`
  commitSha,
  linkPath,          // "/workspaces/<workspaceId>/runs/<runId>", joined with the app origin by the renderer
  facts: { repo, pipeline },           // the flat, filterable subset
}
```

The gate types add `gateName`, `gateItemIndex` and `facts.gate`. `gate.resumed` adds `actorUserId`
(the deciding voter) and `resumedBy: { userId, role }[]`; `gate.rejected` adds `actorUserId` and
`reason` (string or null).

### Extending the catalog

The catalog is assembled from per-area parts. An area adds an `*EventTypes` object and a matching
`*EventPayloadSchemas` object in `@mocco/common` and spreads both into `DomainEventTypes` and
`domainEventPayloadSchemas`. The inbound source types (`sentry.issue.created`, `github.push`, …,
issue #249, [notification relay design](../superpowers/specs/2026-09-25-notification-relay-design.md)
§4) join this way.

## Publishing

Services depend on the `EventPublisher` port (`domain/events/ports.ts`), injected by their
composition root (`getEventBus()`):

```ts
await bus.publish({
  type: DomainEventTypes.gatePending,
  workspaceId,
  subject: { type: 'run_gate', id: gate.id },
  payload: { … },          // typed by `type`
  occurredAt,              // optional, default now
  projectId,               // optional
  dedupeKey,               // optional
});
// → { event, created, subscribers }
```

- The payload is parsed with the type's schema first. A mismatch throws `DomainEventPayloadError`
  and an unknown type throws `UnknownDomainEventTypeError`; nothing is written.
- **`dedupeKey`**: unique per workspace. A second publish with the same key returns the first
  event with `created: false` and enqueues nothing. Use it when the same fact can arrive twice (an
  inbound webhook redelivery keyed by its receipt).
- **After the state change, best-effort.** Governance calls `publishBestEffort(bus, label, build)`:
  building the payload and publishing are both inside a guard that logs and swallows, so a failed
  publish never rolls back or fails the run or gate. A crash between the state change and the
  publish loses the event; a consumer that must not miss one reconciles on a schedule.

## Subscribing

Subscribers are registered in one place, `createEventBus` in `domain/events/subscriptions.ts`:

```ts
bus.subscribe('gate.*', 'notification.fan-out', async event => {
  // event.type is 'gate.pending' | 'gate.resumed' | 'gate.rejected'; event.payload is typed by it
});
```

- `subscribe(pattern, name, handler)`: `pattern` is an exact catalog type or `prefix.*` (any type
  under `prefix.`). An exact pattern outside the catalog, or a duplicate `name`, throws at startup.
- **The name is permanent.** It is part of the delivery job's dedupe key and of the delivery
  ledger. Use `<domain>.<purpose>`.
- **Why one list:** publish and delivery can run in different processes. The publishing lambda
  decides which subscribers get a job; the tick finds the handler by name. Both composition roots
  build their bus with `createEventBus`: `domain/events/instance.ts` (`getEventBus()`, for
  publishers) and `runtime/jobs.ts` (for `events.deliver`).
- `createEventBus` builds subscriber services from repos and classes over its `db` (or calls a
  pure `domain/<x>/subscribers.ts` factory). It never imports an `instance.ts`, which keeps the
  composition free of import cycles (see [jobs: composition](./jobs.md#composition)).

## Delivery

For each matching subscriber, `publish` enqueues `events.deliver { eventId, subscriber }` with
`dedupe_key = <eventId>:<subscriber>`, the event's workspace, and `kick: true`. The handler
(`EventBus.deliver`):

1. throws `UnknownSubscriberError` if the name isn't registered in this process (a normal failure,
   retried — e.g. an older deploy picking up a newer job);
2. returns if the event is gone (pruned before its delivery ran);
3. returns if `mocco_domain_event_deliveries` already has `(event, subscriber)`;
4. parses the stored row through the catalog and calls the subscriber;
5. records the pair in the ledger.

So a subscriber is called once per event even if its delivery is enqueued twice. A subscriber that
throws fails the job, which retries with the queue's backoff (or at a `RetryAt` time) and ends
`dead` after its attempts. The ledger is written after the subscriber returns, so a crash in
between calls it again: delivery is **at-least-once** and subscribers must be idempotent.

## Retention

`events.prune` runs daily as a platform schedule (like `jobs.prune`) and deletes events whose
`occurred_at` is older than 30 days; their ledger rows cascade. The audit log is untouched.

## Testing

`domain/events/testing/event-bus.ts` has `createTestEventBus(db)` (a real bus over pglite that
doesn't kick) and `FailingEventPublisher` (every publish rejects), for service tests that assert the
stored rows or that a broken bus doesn't fail the action. `EventBus.test.ts` wires the real queue
and runner to cover fan-out, wildcards, dedupe keys, retries and the ledger.
