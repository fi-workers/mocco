---
title: CI conventions (supply-chain hardening)
type: reference
status: active
created: 2026-07-04
updated: 2026-07-04
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
- Publishing/release workflows do not exist yet; when they do, they follow rules 3–5 and get their own review.
- **Required checks**: after `ci.yml` lands, branch protection on `main` must require the `ci` check (checks that only advise don't gate — write ≠ deploy applies to us too).
