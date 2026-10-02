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
  - packages/backend/src/domain/flags/apply-ops.ts
  - packages/backend/src/domain/flags/compile-ruleset.ts
  - packages/backend/src/transport/trpc/routers/flags.ts
  - packages/backend/src/transport/ext/v1/flags.ts
  - packages/sdk-flags-core/src/evaluate.ts
  - packages/sdk-openfeature-server/src/openfeature-server.ts
---

# Feature flags

Feature flags are product line 2 (#101). They are enabled per workspace (`Products.flags`) and scoped to a project. This page describes what exists today. The [feature map](./feature-map.md) lists what comes next: targeting rules in the console, gated changesets, the kill switch and the client SDKs.

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

`applyChangeset` refuses changes to an environment that has a change gate (`ProtectedEnvironmentError`). Gated changesets, which become approval requests under that gate, come in #141.

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

`@mocco/openfeature-server` is the OpenFeature server provider over it ([SDK packages](./sdk.md)). It polls this endpoint with `If-None-Match` (default every 30 s), evaluates in memory, emits `PROVIDER_CONFIGURATION_CHANGED` with `flagsChanged`, and keeps the last good ruleset as `PROVIDER_STALE` when a poll fails or returns a ruleset it can't use. An optional `bootstrap` ruleset lets it start while Mocco is unreachable. `transport/ext/v1/flags-sdk.test.ts` runs the provider against the real routes.

flagd's HTTP sync works against the same endpoint (`authHeader: "Bearer mk_sec_…"`; it sends `If-None-Match` too), for teams that run flagd or use a non-JavaScript OpenFeature provider; the customer [quickstart](../customer/flags/quickstart.md) shows the command.

A key is bound to one environment when it is created: `flagEnvironmentId` is required with `flags:read` and refused without it ([public API](./public-api.md#keys)).

## API

The `flags` tRPC router uses `productProcedure(Products.flags)`: the caller must be a workspace member, the project must be in the workspace, and the product must be enabled.

| Procedure | Purpose |
|---|---|
| `environments`, `createEnvironment` | List and create environments |
| `list`, `create`, `createBoolean` | List flags with their config in every environment; create a typed flag, or a boolean one |
| `segments` | An environment's segments |
| `preview` | Evaluate every flag for a context, with unsaved ops applied (nothing is written) |
| `applyChangeset` | Apply ops to an unprotected environment against `baseVersion` |
| `history` | An environment's last 50 changesets, newest first |
| `ruleset` | An environment's current snapshot (version, ETag, document) |

The console page is **Feature flags** in the project tabs (`/workspaces/:id/p/:projectId/flags`), with environments, flags, and per environment its segments and history. Each flag has a page (`…/flags/:flagKey?env=`) with its rules, fallthrough and preview.
