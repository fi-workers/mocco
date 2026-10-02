---
title: CI conventions (supply-chain hardening)
description: Supply-chain hardening rules the CI workflows must follow — SHA-pinned actions, no pull_request_target with checkout, minimal permissions, and no secrets in PR workflows.
type: reference
status: active
created: 2026-07-04
updated: 2026-10-02
confidence: high
owner: andrea
tags: [reference, ci, security, supply-chain, github-actions]
---

# CI conventions (supply-chain hardening)

> Design spec the CI workflows must follow. Grounded in the 2026-05 TanStack npm supply-chain compromise post-mortem, where three known weaknesses were chained: a `pull_request_target` pwn-request → cache poisoning across the trust boundary → OIDC token theft from runner memory. Mocco is an open-source repo accepting fork PRs, so this applies to us directly.

## Rules

1. **Pin third-party actions to commit SHAs.** `uses: actions/checkout@<40-char sha> # v4.x` — never floating tags (`@v4`, `@main`). Same policy as our exact-pinned npm dependencies, extended to CI.
2. **Never use `pull_request_target` with code checkout.** Fork PRs run under plain `pull_request` (read-only token, no secrets). Any future workflow needing write perms on PR events requires explicit security review.
3. **Do not share caches across trust boundaries.** PR workflows and release/publish workflows must not restore the same cache keys. Scope cache keys per workflow class (e.g. prefix `pr-` vs `release-`), or disable caching in privileged workflows entirely.
4. **`permissions` is explicit and minimal in every workflow.** Top-level `permissions: contents: read` default; job-level escalation only where needed. `id-token: write` (OIDC) may appear only in a dedicated, minimal publish workflow — never in test/lint workflows.
5. **No secrets in PR-triggered workflows.** Lint/test need none. Anything needing secrets runs on `push` to main or manual dispatch.
6. **Fail loud on tampering vectors.** Lockfile is authoritative: `yarn install --immutable` in CI. Install scripts disabled where practical.
7. **Commit identity:** spoofed bot identities (e.g. fake `claude@users.noreply`) were an IOC in the TanStack attack. Prefer signed/verified commits for release-critical branches when the team grows.

## Initial workflows (the CI PR)

- `ci.yml` — on `pull_request` + `merge_group` + `push` to main: install (immutable, dependency scripts disabled) → format check → lint (backend+frontend, incl. ts-check) → test (pglite) → migration-drift check → frontend build. No secrets, `permissions: contents: read`, SHA-pinned actions, `pr-` scoped cache (or none).
- `publish.yml` — on `push` to main: install → `yarn sdk:build` → `yarn test-sdk` → `changesets/action`, which opens or updates the "chore: version packages" PR and, when that PR lands, runs `yarn release` to upload. It is the only workflow with `id-token: write`.
  - **The upload uses the npm CLI, not `changeset publish`.** Changesets publishes through the detected package manager, and yarn has no support for npm's trusted publishing — it only looks for a stored `npmAuthToken` and fails with `YN0033: No authentication configured`, whatever OIDC the job was granted. `scripts/publish-packages.mjs` runs `npm publish --provenance` per public workspace instead, in dependency order, skipping versions already on the registry so a re-run is safe, and printing the `New tag:` lines `changesets/action` reads to tag the commit. The job installs a pinned npm first, because trusted publishing needs 11.5.1+ and Node 22 bundles npm 10.
  - It needs the `@mocco` scope linked to this repository as a trusted publisher on npmjs.com. Without that link the publish fails at the registry rather than at the credential, which is the point: no long-lived npm token exists to leak.
- `migrate.yml` — on `push` to main when a migration, `drizzle.config.ts` or the workflow changes, and on manual dispatch: install (immutable, dependency scripts disabled) → `node scripts/migrate-production.mjs` (drizzle-orm's migrator; prints the driver error code on failure) against production. Its only secret, `DATABASE_URL`, lives in the `migrations` GitHub environment, which only `main` may deploy from. It never runs on pull requests. It doesn't use `yarn db:migrate` because `yarn db:migrate` goes through `with-env`, where the committed local `DATABASE_URL` wins over the process environment.
- **Required checks**: after `ci.yml` lands, branch protection on `main` must require the `ci` check (checks that only advise don't gate — write ≠ deploy applies to us too).
