---
title: OTA code signing — the key stays in CI, rollbacks are pre-signed
description: Mocco-hosted OTA updates are signed in the customer's CI with a key Mocco never holds; Mocco stores certificates, verifies every signed byte string before storing it, and serves the bytes unchanged; rollback and no-update artifacts are signed at publish time so rollbacks need no key; KMS managed signing is a later opt-in.
type: adr
status: draft
created: 2026-10-01
updated: 2026-10-01
confidence: medium
owner: andrea
decision_date: 2026-10-01
stakeholders: [andrea]
tags: [adr, ota, signing, security, expo-updates]
related:
  - ../specs/2026-09-24-ota-design.md
  - ./0021-ota-client-is-expo-updates-protocol-v1.md
---

# ADR 0022 — OTA code signing: the key stays in CI, rollbacks are pre-signed

## Context

With Mocco hosting updates (ADR 0021), the integrity of what runs on users' phones depends on who can produce a valid signature. If Mocco held the signing key, a compromise of Mocco, or of anyone with database access, could push code to every device of every customer. Expo Updates verifies an RSA signature over the exact manifest bytes against a certificate embedded in the binary, so the server can serve signed bytes it could not have produced.

Rollbacks are the hard case. A device only accepts a manifest whose `createdAt` is newer than the update it runs, so rolling back means serving a *new* manifest of the old code, which must also be signed.

## Decision

1. **The private key lives in the customer's CI** (a CI secret, or a CI-side KMS through an external-signer command). `@mocco/ota-cli` signs with `rsa-v1_5-sha256`, the algorithm expo-updates supports.
2. **Mocco stores certificates, not keys.** Each app has one or more `active` certificates, keyed by `keyid`. Several can be active at once, because rotating means a new binary and runtime version, and older binaries still verify against the old certificate.
3. **Verify before storing, serve without re-serializing.** Finalizing an upload rejects any update or directive whose signature doesn't verify against an active certificate with its `keyid`. Mocco stores the exact signed body and signature and serves them byte for byte; an update row is never modified.
4. **Pre-signed rollback.** At publish time the CLI also signs:
   - for each channel the release may reach, a *republish* of that channel's current active update (new `id`, `createdAt` just after the new release), so rolling back from the new release is an instant head change;
   - a `rollBackToEmbedded` directive whose `commitTime` is just after the release.

   "No update" needs no signature: the client accepts an unsigned 204 even when code signing is enforced (ADR 0021).
5. **When no pre-signed artifact fits** (rolling back two releases, or a head that changed after upload), the console offers rolling back to the embedded build (always available) or a re-sign job: Mocco dispatches the customer's own `resign` workflow through the existing execution domain, and the result goes through the same finalize checks.
6. **Managed signing is a later opt-in per app** behind a `ManifestSigner` port (AWS KMS, GCP KMS, or an encrypted file for self-host), signing only inside the governed apply path and auditing every signature.

## Consequences

- A Mocco compromise can stop or roll back updates but cannot ship new code to devices of an app that enforces code signing.
- Every publish uploads a few extra small signed documents, and the CLI must fetch the current channel heads (`rollbackTargets`) before signing.
- Some rollbacks are not instant (the re-sign path takes minutes). Rolling back to the embedded build is always instant.
- Apps that don't enforce code signing (`signing_required = false`) give up this guarantee; the console labels them.

## Confirmed from the client source

ADR 0021 records, with source locations: the client verifies `rsa-v1_5-sha256` over the exact part bytes; the default `keyid` is `"root"`; a rollback directive is accepted only when its `commitTime` is strictly after the launched update's; an unsigned 204 is accepted under code signing. Still to run once on an Android emulator and an iOS simulator against Mocco: a signed staging update installs, a tampered one is rejected, and a rollback directive applies.
