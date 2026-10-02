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

A **config** (`mocco_flag_configs`) is a flag's state in one environment: `enabled`, `killed`, the default variant, the off variant (what a killed flag serves) and a random bucketing `salt`. Configs are written only by applied changesets, and each records the environment version that last changed it.

A **changeset** (`mocco_flag_changesets`) is an ordered list of ops against a base version:

| Op | Effect |
|---|---|
| `add_flag` | Adds a flag to the environment, disabled, with its default and off variants |
| `set_enabled` | Switches the flag on or off |
| `set_default_variant` | Changes the variant an enabled flag serves |

A changeset stores its ops, the rendered diff (before and after per field), and a `content_hash`: sha-256 over the canonical JSON of `{environmentId, baseVersion, ops}`. The hash is what a later approval will pin.

A **ruleset snapshot** (`mocco_flag_ruleset_snapshots`) is the compiled document of one environment version, with a strong ETag. Snapshots are never updated. A new environment starts with an empty version-0 snapshot.

## Applying a changeset

`RulesetPublisher.apply` is the only writer of configs. It runs in one transaction:

1. It takes the environment's advisory lock (`AdvisoryLockNamespaces.flagEnvironment`) and reads the current version.
2. It refuses the changeset with `ChangesetConflictError` (CONFLICT) if the base version is not the current one. A caller that read an older version must reload, so a stale toggle never overwrites a newer change.
3. It applies the ops with the pure `applyOps`. An unknown flag or variant, or a flag added twice, is `InvalidChangeError` (BAD_REQUEST). So is a changeset that changes nothing.
4. It writes the changeset as `applied`, upserts the changed configs, compiles the ruleset, writes the snapshot and sets `current_version` to base + 1.

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
| `list`, `createBoolean` | List flags with their config in every environment; create a boolean flag |
| `applyChangeset` | Apply ops to an unprotected environment against `baseVersion` |
| `history` | An environment's last 50 changesets, newest first |
| `ruleset` | An environment's current snapshot (version, ETag, document) |

The console page is **Feature flags** in the project tabs (`/workspaces/:id/p/:projectId/flags`).
