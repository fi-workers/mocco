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
  triggeredByUserId, // null once the user is deleted
  triggeredByName,   // the triggerer's display name, or null
  facts: { repo, pipeline },           // the flat, filterable subset
}
```

- `run.failed` adds `failedStep: { name, index } | null` and `logsUrl: string | null` (both null
  when unknown, e.g. an executor that never reported).
- The gate types add `gateName`, `gateItemIndex` and `facts.gate`. `gate.pending` adds
  `requirements: { role, count }[]`, the gate's resume requirements as snapshotted on the run.
- `gate.resumed` adds `actorUserId` (the deciding voter) and `resumedBy: { userId, role }[]`;
  `gate.rejected` adds `actorUserId` and `reason` (string or null).
- Governance payloads carry facts, not a rendered message: they have no `NeutralMessage` (unlike
  the inbound types of the relay design). Notification templates render them.
- Each governance event has the dedupe key `<type>:<subject id>` (`run.succeeded:<runId>`,
  `run.failed:<runId>`, `gate.pending:<gateId>`, `gate.resumed:<gateId>`, `gate.rejected:<gateId>`),
  so concurrent callbacks or votes that both reach a transition publish one event.

### Extending the catalog

The catalog is assembled from per-area parts. An area adds an `*EventTypes` object and a matching
`*EventPayloadSchemas` object in `@mocco/common` and spreads both into `DomainEventTypes` and
`domainEventPayloadSchemas`. The inbound source types (`sentry.issue.created`, `github.push`, …,
issue #249, [notification relay design](../superpowers/specs/2026-09-25-notification-relay-design.md)
§4) join this way.

**Changes must stay backward-compatible for 30 days.** A stored payload is parsed again with the
current schema when it is delivered, and events live 30 days. So never remove a type, remove or
rename a field, or make a field stricter while events of the old shape can still be stored. A new
field is added with a default (`.nullable().default(null)`, `.default([])`), as the fields above
that arrived after the first release are, so older rows still parse.

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
  event with `created: false` and fans it out again: a delivery job that is still live dedupes, one
  that finished is a ledger no-op, and one that is missing (the first publish crashed between the
  insert and the enqueue) is created. So retrying a publish is always safe and repairs a lost
  fan-out. Use a key whenever the same fact can be published twice (an inbound webhook redelivery
  keyed by its receipt, a governance transition).
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

So a subscriber is normally called once per event, even if its delivery is enqueued twice. A subscriber that
throws fails the job, which retries with the queue's backoff (or at a `RetryAt` time) and ends
`dead` after its attempts. The ledger is written after the subscriber returns, so a crash in
between calls it again: delivery is **at-least-once** and subscribers must be idempotent.

### Ordering

`seq` is the insert order of events (assigned at insert, not at commit, so it is not a gap-free
cursor). Publishing order is all it records: every delivery is its own job, run by kicks and ticks
that can retry or overlap, so a subscriber may receive a later event before an earlier one (a
`gate.resumed` before the `gate.pending` it answers, after a retry). A consumer that cares orders by
`seq` or `occurredAt` itself, for example by ignoring an event older than the state it already
holds.

## Retention

`events.prune` runs daily as a platform schedule (like `jobs.prune`) and deletes events whose
`occurred_at` is older than 30 days; their ledger rows cascade. It deletes in batches of
`EVENT_PRUNE_BATCH_SIZE` (1000) per statement and keeps going until a batch comes back short or the
run's lock deadline has passed; whatever is left goes with the next day's run. The audit log is
untouched.

## Testing

`domain/events/testing/event-bus.ts` has `createTestEventBus(db)` (a real bus over pglite that
doesn't kick) and `FailingEventPublisher` (every publish rejects), for service tests that assert the
stored rows or that a broken bus doesn't fail the action. `EventBus.test.ts` wires the real queue
and runner to cover fan-out, wildcards, dedupe keys, retries and the ledger.
