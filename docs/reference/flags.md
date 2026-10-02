---
title: Feature flags
description: How Mocco stores feature flags — environments (flag targets), flag definitions, per-environment configs, changesets, and the immutable flagd ruleset snapshot each applied change compiles to.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [reference, flags, openfeature, flagd]
related:
  - ../adr/0023-flag-targets-are-evaluation-scopes.md
  - ../adr/0024-flags-openfeature-flagd-ruleset-ofrep.md
  - ../specs/2026-09-24-feature-flags-design.md
  - ./project.md
code_refs:
  - packages/common/src/flags.ts
  - packages/backend/src/domain/flags/FlagService.ts
  - packages/backend/src/domain/flags/RulesetPublisher.ts
  - packages/backend/src/domain/flags/FlagGovernanceService.ts
  - packages/backend/src/domain/flags/KillSwitchService.ts
  - packages/backend/src/domain/flags/apply-ops.ts
  - packages/backend/src/domain/flags/compile-ruleset.ts
  - packages/backend/src/transport/trpc/routers/flags.ts
  - packages/backend/src/transport/ext/v1/flags.ts
  - packages/backend/src/transport/ext/v1/ofrep.ts
  - packages/backend/src/domain/flags/ofrep.ts
  - packages/sdk-flags-core/src/evaluate.ts
  - packages/sdk-openfeature-server/src/openfeature-server.ts
---

# Feature flags

Feature flags are product line 2 (#101). They are enabled per workspace (`Products.flags`) and scoped to a project. This page describes what exists today. The [feature map](./feature-map.md) lists what comes next: the client SDKs, telemetry and flags-as-code.

## Model

An **environment** (`mocco_flag_environments`) is a flag target in the sense of [ADR 0023](../adr/0023-flag-targets-are-evaluation-scopes.md): an evaluation scope with its own ruleset. It has a key (a lowercase slug), a display name, a `current_version` and an optional `change_gate`. Nothing reads its name; an environment is protected only when it has a change gate.

A **flag** (`mocco_flags`) is defined once per project: its key, type, variants, lifecycle and description. Today the console creates boolean flags with the variants `on: true` and `off: false`.

A flag's **type** is `boolean`, `string`, `number` or `json`, and every variant's value must match it (`json`: an object or an array); `flags.create` refuses a mismatch.

A **config** (`mocco_flag_configs`) is a flag's state in one environment: `enabled`, `killed`, the default variant, the off variant (what a killed flag serves), ordered `rules`, an optional fallthrough `rollout`, and a random bucketing `salt`. Configs are written only by applied changesets, and each records the environment version that last changed it.

A **rule** is a list of clauses that must all match and what it serves: a variant, or a percentage rollout (`[{ variant, weight }]`, order kept). A clause is either an attribute comparison (`in`, `not_in`, `starts_with`, `ends_with`, `lt`, `lte`, `gt`, `gte`, `semver_eq/lt/lte/gt/gte`) or segment membership (`{ segment, negate }`).

A **segment** (`mocco_flag_segments`) belongs to one environment, so editing it is a changeset on that environment and is governed by its gate. It has included and excluded targeting keys and OR-of-AND groups of attribute clauses. Segments are changed by `set_segment` and `delete_segment` ops; a segment a rule still uses can't be deleted.

A **changeset** (`mocco_flag_changesets`) is an ordered list of ops against a base version:

| Op | Effect |
|---|---|
| `add_flag` | Adds a flag to the environment, disabled, with its default and off variants |
| `set_enabled` | Switches the flag on or off |
| `set_default_variant` | Changes the variant served when no rule matches (and to keyless callers under a rollout) |
| `set_rules` | Replaces the flag's rules |
| `set_rollout` | Sets or clears the fallthrough percentage rollout |
| `set_segment`, `delete_segment` | Create, replace or delete a segment |
| `kill`, `restore` | Serve the off variant to everyone / undo it (a kill normally goes through `KillSwitchService`) |
| `set_off_variant` | What a kill serves |

A changeset stores its ops, the rendered diff (before and after per field), and a `content_hash`: sha-256 over the canonical JSON of `{environmentId, baseVersion, ops}`. The hash is what a later approval will pin.

A **ruleset snapshot** (`mocco_flag_ruleset_snapshots`) is the compiled document of one environment version, with a strong ETag. Snapshots are never updated. A new environment starts with an empty version-0 snapshot.

## Applying a changeset

`RulesetPublisher.apply` is the only writer of configs. It runs in one transaction:

1. It takes the environment's advisory lock (`AdvisoryLockNamespaces.flagEnvironment`) and reads the current version.
2. It refuses the changeset with `ChangesetConflictError` (CONFLICT) if the base version is not the current one. A caller that read an older version must reload, so a stale toggle never overwrites a newer change.
3. It applies the ops with the pure `applyOps`. An unknown flag, variant or segment, a flag added twice, or deleting a segment in use is `InvalidChangeError` (BAD_REQUEST). So is a changeset that changes nothing.
4. A compiled ruleset over 5 MB is `RulesetTooLargeError` (BAD_REQUEST). Rules, clause values, rollout entries and segment keys (10,000 per list) have their own limits (`FlagLimits` in `@mocco/common/flags`).
5. It writes the changeset as `applied`, upserts the changed configs and segments, compiles the ruleset, writes the snapshot and sets `current_version` to base + 1.

After the commit, `FlagService` records `flag.changeset.applied` in the audit log with the changeset id, version, source, content hash and diff.

Creating a flag adds it, disabled, to every environment in the same transaction, one changeset per environment. The environments are locked in id order, so concurrent creations cannot deadlock. A disabled flag serves the caller's code default, which is what an unknown flag serves, so adding one changes no behavior in any environment. Creating an environment adds every existing flag to it, disabled.

## Protected environments

An environment with a `change_gate` is protected (ADR 0023). `FlagGovernanceService` decides its changes through ApprovalService (ADR 0020), so flag changes, OTA promotions and version policies share one approval engine, voter rules and audit trail.

- **Propose.** `applyChangeset` on a protected environment validates the ops against `baseVersion` (`RulesetPublisher.dryRun`: the same refusals and size limit as an apply), records a `pending` changeset with the gate pinned in `requirements` and `expires_at` (7 days), and opens a `pre_approval` request (`flags.changeset`) whose action pins `{changesetId, environmentId, contentHash, baseVersion}`. The outcome is `pending_approval`. `flag.changeset.proposed` is audited and `flags.changeset.requested` is published.
- **Vote.** `flags.voteChangeset` takes the `contentHash` the voter reviewed and refuses a different one (`ChangesetHashMismatchError`). The vote rules are ApprovalService's: N-of-M per role slot, one slot per person (a member of two roles fills one), `prevent_self` on the proposer, `reason_required`.
- **Apply.** The approval handler applies the changeset through the publisher with its own `baseVersion`, marking the same row `applied`. If the environment moved meanwhile, it becomes `conflicted` and nothing is written.
- **Reject, withdraw, rebase, expire.** A rejection marks it `rejected`. The proposer can withdraw it (`withdrawn`) or rebase a pending or conflicted one: the same ops proposed on the current version, with a new hash and a new request, so no earlier vote counts. The old pending changeset becomes `superseded` only once the new proposal succeeds. The `flags.changesets.expire` job (every 15 minutes) expires those past `expires_at`. Each transition is audited (`flag.changeset.rejected`, `.conflicted`, `.withdrawn`, `.expired`).
- **Gates.** `flags.setChangeGate` protects an unprotected environment at once. Changing or removing a protected environment's gate is a `flags.change_gate` request under its current gate. A changeset keeps the requirements it was proposed under (`flag.change_gate.changed` is audited).

## Kill switch

`KillSwitchService.kill` (#142, ADR 0024) applies a `kill` op through the publisher at once, with `source: kill` and no base version, on any environment: it bypasses the change gate. A reason is required. If the environment has `kill_roles` (migration 0034), only members of one of those roles may kill (`KillNotAllowedError`); empty means any workspace member, and `flags.setKillRoles` is for workspace owners and admins. A kill is audited as `flag.killed` (actor, reason, changeset, version) and published as `flags.flag.killed`. On a protected environment it also opens a post-hoc `review` request (`flags.kill`) under the gate.

`restore` and `set_off_variant` are normal ops: gated on a protected environment. An applied restore is audited as `flag.restored`.

## The compiled ruleset

The snapshot is a flagd flag-definition document, valid against flagd's v0 schema (the tests validate it with the schemas vendored under `domain/flags/testing/flagd-schema-v0/`). flagd requires metadata values to be primitives, so Mocco's metadata uses flat `mocco.*` keys:

```json
{
  "$schema": "https://flagd.dev/schema/v0/flags.json",
  "metadata": {
    "mocco.environment": "production",
    "mocco.version": 2,
    "mocco.generatedAt": "2026-10-02T00:00:00.000Z",
    "mocco.bucketing": "mocco-v1"
  },
  "flags": {
    "new-checkout": {
      "state": "ENABLED",
      "variants": { "on": true, "off": false },
      "defaultVariant": "on",
      "targeting": {},
      "metadata": { "mocco.offVariant": "off", "mocco.killed": false, "mocco.lifecycle": "temporary" }
    }
  }
}
```

Targeting compiles to `if: [rule₁ condition, rule₁ serve, …, fallthrough]`:

- Attribute clauses become `in`, `!`, `starts_with` / `ends_with` (an `or` over the values), `sem_ver`, and numeric comparisons guarded by `!(x in [null])`, so a missing attribute never compares as 0. That guard is the presence test the JsonLogic engines agree on (json-logic-engine reads `0 != null` as false).
- Segments are inlined: not excluded, and included or matching a group. That is why the ruleset is server-key-only.
- A rollout is `if: [targetingKey, fractional: [cat: [salt, targetingKey], [variant, weight]…], null]`. Callers without a targeting key fall back to the default variant.

`flagd-crosscheck.test.ts` evaluates a compiled ruleset with every clause kind, segments and rollouts against 3,000 generated contexts with both `@mocco/flags-core` and `@openfeature/flagd-core`, and requires identical results. `compile-ruleset.test.ts` checks that 100K keys land within ±1% of the weights and that keys in at 10% stay in at 20%.

A disabled flag is emitted as `state: DISABLED`. A killed flag is emitted as `ENABLED` with its off variant as the default and no targeting, so even a stale or third-party flagd client serves the off variant ([ADR 0024](../adr/0024-flags-openfeature-flagd-ruleset-ofrep.md)).

## Serving server SDKs

`GET /v1/flags/ruleset` returns the current snapshot of the environment the key is bound to. It needs a secret key with `flags:read`. A ruleset holds every targeting rule, so publishable keys (403) and secret keys sent from a browser (401) are refused; browsers and apps will use OFREP (#143).

```http
GET /v1/flags/ruleset
Authorization: Bearer mk_sec_…
If-None-Match: "kq3…"

HTTP/1.1 304 Not Modified
ETag: "kq3…"
Cache-Control: private, no-cache
```

The response is the flagd document with `ETag` and `Cache-Control: private, no-cache`. A request whose `If-None-Match` lists the current tag (weak or strong, or `*`) gets a `304`. The endpoint reads only the head of the newest snapshot (version and ETag) and loads the document only when the caller doesn't hold it, so polling costs one small query. ### SDKs

`@mocco/flags-core` evaluates a ruleset locally: the restricted JsonLogic subset, flagd's `fractional` (MurmurHash3 x86_32; bucket `(hash × totalWeight) >> 32`), `sem_ver` with Go `x/mod/semver` semantics, `starts_with` and `ends_with`, and flagd's resolution rules (`$flagd.flagKey` and `$flagd.timestamp` in the context; DISABLED, STATIC, DEFAULT, TARGETING_MATCH; FLAG_NOT_FOUND, TYPE_MISMATCH, PARSE_ERROR, GENERAL). A conformance test replays flagd's own evaluator cases (`conformance.test.ts`). `parseRuleset` refuses a document with an operator outside the subset before it is used.

`@mocco/openfeature-server` is the OpenFeature server provider over it ([SDK packages](./sdk.md)). It listens to the change stream and fetches this endpoint with `If-None-Match` as soon as the ruleset changes, also polling every 30 s as a fallback (`changeDetection: 'poll'` polls only). It evaluates in memory, emits `PROVIDER_CONFIGURATION_CHANGED` with `flagsChanged`, and keeps the last good ruleset as `PROVIDER_STALE` when a poll fails or returns a ruleset it can't use. An optional `bootstrap` ruleset lets it start while Mocco is unreachable. `transport/ext/v1/flags-sdk.test.ts` runs the provider against the real routes.

flagd's HTTP sync works against the same endpoint (`authHeader: "Bearer mk_sec_…"`; it sends `If-None-Match` too), for teams that run flagd or use a non-JavaScript OpenFeature provider; the customer [quickstart](../customer/flags/quickstart.md) shows the command.

### Change stream

`GET /v1/flags/stream` is an OFREP event stream (`text/event-stream`). When the environment's version moves, it sends `data: {"type":"refetchEvaluation","etag":"<snapshot ETag>"}` with `id` set to the version, so `Last-Event-ID` resumes and a reconnecting client hears about a change it missed. It sends a `: ping` comment every 25 s and closes after 240 s (Vercel's function limit); clients reconnect.

It is authenticated by a `flags:read` key in the header (server SDKs), or by a stream token in `?token=`. Browsers' `EventSource` can't send headers, so the OFREP bulk response advertises a tokenized URL. A token (`StreamTokens`, HMAC with a key derived from `AUTH_SECRET`, valid for an hour) names one environment and grants nothing else. Without `AUTH_SECRET`, no stream is advertised and clients poll.

Until the realtime foundation (#123) exists, each connection checks the environment's newest snapshot version once a second, which is one indexed read. Swapping to `RealtimePublisher` changes only this route.

## OFREP (browsers and apps)

`POST /v1/ofrep/v1/evaluate/flags` (bulk) and `POST /v1/ofrep/v1/evaluate/flags/{key}` implement the OpenFeature Remote Evaluation Protocol, so the OFREP `baseUrl` is the public API base (`https://api.mocco.club/v1`). Any `flags:read` key works:

- **Who sees what.** A publishable key evaluates only flags marked **available to browsers and apps** (`client_visible`, off by default, set on the flag's page). Any other flag is `FLAG_NOT_FOUND`, the same as a missing one. A secret key sees every flag.
- **What a response carries.** Resolved values only: `key`, `value`, `variant`, `reason`. Never rules, segment lists or Mocco's flag metadata.
- **Reasons.** OFREP's enum has no `DEFAULT`, so a value that fell through to the default variant is `STATIC`. A disabled flag is `DISABLED` with no `value` (OFREP's code-default).
- **Errors.** `PARSE_ERROR` or `GENERAL` per flag. A body without an object `context` is `400 INVALID_CONTEXT`.
- **Caching.** The bulk response's `ETag` hashes the snapshot ETag, the key's audience and the context, so `If-None-Match` with the same context answers `304`. The response also lists `eventStreams` (the tokenized stream URL).

`transport/ext/v1/ofrep.test.ts` validates responses against OFREP's OpenAPI schemas (vendored in `domain/flags/testing/ofrep-openapi-schemas.json`, with one documented fix: the published `oneOf` for a value accepts no value at all). It also checks that segment keys and rules never appear, and runs the generic `@openfeature/ofrep-web-provider` against the routes.

A key is bound to one environment when it is created: `flagEnvironmentId` is required with `flags:read` and refused without it ([public API](./public-api.md#keys)).

## API

The `flags` tRPC router uses `productProcedure(Products.flags)`: the caller must be a workspace member, the project must be in the workspace, and the product must be enabled.

| Procedure | Purpose |
|---|---|
| `environments`, `createEnvironment` | List and create environments |
| `list`, `create`, `createBoolean` | List flags with their config in every environment; create a typed flag, or a boolean one |
| `segments` | An environment's segments |
| `preview` | Evaluate every flag for a context, with unsaved ops applied (nothing is written) |
| `applyChangeset` | Apply ops against `baseVersion` (`applied`), or propose them on a protected environment (`pending_approval`) |
| `changeset`, `voteChangeset`, `withdrawChangeset`, `rebaseChangeset` | A changeset with its votes; vote with the reviewed content hash; withdraw or rebase your own |
| `setChangeGate` | Protect, re-gate or unprotect an environment |
| `kill`, `setKillRoles` | Kill a flag now (gate bypassed, reason required); choose who may kill |
| `setClientVisible` | Let publishable keys evaluate a flag over OFREP, or stop them |
| `history` | An environment's last 50 changesets, newest first |
| `ruleset` | An environment's current snapshot (version, ETag, document) |

The console page is **Feature flags** in the project tabs (`/workspaces/:id/p/:projectId/flags`), with environments, flags, and per environment its segments and history. Each flag has a page (`…/flags/:flagKey?env=`) with its rules, fallthrough and preview.
