---
title: Flags are OpenFeature-first, with a flagd-compatible ruleset, OFREP for clients, and a one-way kill switch
description: Mocco flags compile to a flagd flag-definition document restricted to a JsonLogic subset with MurmurHash3 fractional bucketing and a per-flag salt (pinned as mocco-v1); server SDKs evaluate it locally, clients use OFREP bulk evaluation; Kill serves the declared off variant and may bypass the gate while restore is gated; SDK keys are ADR 0017's keys with flags scopes, and the SDKs are MIT.
type: adr
status: draft
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
decision_date: 2026-10-02
stakeholders: [andrea]
tags: [adr, flags, openfeature, flagd, ofrep, sdk, licensing]
related:
  - ./0017-public-v1-api-keys-and-sdk-licensing.md
  - ./0020-approvals-outside-pipeline-runs.md
  - ./0023-flag-targets-are-evaluation-scopes.md
  - ../specs/2026-09-24-feature-flags-design.md
  - ../reference/sdk.md
---

# ADR 0024 — OpenFeature-first flags: flagd ruleset, OFREP, kill switch

## Context

Customers already code against OpenFeature, and other languages are served by flagd and OFREP providers. A proprietary flag format would mean writing an SDK per language and locking customers in. Two things are specific to Mocco: rules can contain segment member lists that must never reach a browser, and every change to a protected target is governed (ADR 0023), except stopping a bad flag, which must never wait for an approver.

## Decision

1. **The ruleset is a flagd flag-definition document** (pinned to flagd's `v0` schema) plus a Mocco `metadata` block (`environment`, `version`, `generatedAt`, `bucketing: "mocco-v1"`). The compiler emits only a restricted JsonLogic subset — `if`, `and`, `or`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `var`, `cat`, `starts_with`, `ends_with`, `sem_ver`, `fractional` — and `@mocco/flags-core` implements exactly that subset, so flagd in-process providers can consume the same document unchanged.
2. **Deterministic bucketing is `mocco-v1`:** MurmurHash3 x86_32 (seed 0) over the flag's random `salt` concatenated with the `targetingKey`, normalized per flagd's `fractional` to relative weights. Variants keep their order, so raising a percentage only adds users. The salt changes only through a changeset ("re-randomize"). If flagd changes its algorithm, Mocco keeps `mocco-v1` (golden vectors in tests) until a new pinned version is chosen deliberately.
3. **Server SDKs evaluate locally** from `GET /v1/flags/ruleset` (ETag'd, `If-None-Match` → 304) with no network call per evaluation, keeping the last good ruleset when Mocco is unreachable. **Client SDKs (web, React Native) never receive the ruleset**: they use OFREP bulk evaluation (`POST /ofrep/v1/evaluate/flags`), so targeting rules and segment lists stay on the server.
4. **SDK keys are ADR 0017's keys.** Server SDKs use a secret key (`mk_sec_`) with `flags:read`; browsers and apps use a publishable key (`mk_pub_`) with `flags:read`, which reaches only OFREP. A key is bound to one flag target. This replaces the design's earlier `mk_srv_` / `mk_cli_` prefixes.
5. **Kill is one-way and may bypass the gate.** Killing a flag makes the compiler emit `state: ENABLED`, `defaultVariant: <the declared off variant>`, `targeting: {}`, so even a stale or third-party flagd client serves the off variant. Kill applies at once on any target, is always audited and reviewed afterwards (ADR 0020's `review` kind). Restoring a killed flag is a normal change: gated on a protected target. `enabled = false` is emitted as flagd `state: DISABLED` (the caller's code default); docs steer customers to Kill, which serves a server-declared value.
6. **Licensing follows ADR 0017: the SDKs are MIT**, in this repository's `packages/` (see [SDK packages](../reference/sdk.md)), while the server stays AGPL-3.0. The flags design's earlier suggestion of Apache-2.0 or a separate repository is not adopted: one permissive license for the whole SDK family is simpler, and MIT already meets the goal of embedding without AGPL obligations. The OpenFeature SDKs the providers depend on are Apache-2.0, which is compatible.

## Consequences

- Any OpenFeature or flagd client works against Mocco; Mocco writes JS/TS providers only.
- The compiler and `flags-core` must stay within the subset; anything outside it is a compile error, not a runtime surprise.
- Server rulesets are tenant secrets (secret-key only); cheap 304s and streaming carry the load, and a CDN snapshot URL is a later option.
- Kill is the fastest safe action and needs no approver, so restore is where the governance sits.
