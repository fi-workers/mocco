---
title: Slice 3 — GitHub integration (observation) design
description: Design for the observation slice of Mocco's GitHub integration — connect a provider, sync a watched branch's commits into a candidate queue, and view each commit's parsed .mocco.yml pipeline. GitHub is the first provider plugging into a provider-agnostic core; read-only, tenant-isolated, no execution/gates. Refined by a 6-lens adversarial review.
type: design
status: active
created: 2026-07-13
updated: 2026-07-13
confidence: high
owner: andrea
tags: [design, e2b, github, provider, observation, integration]
---

# Slice 3 — GitHub integration (observation) design

> Refined from a brainstorming pass grounded in the deploy-governance research (`제품/배포-거버넌스` 01/02/04/05/06) + 3 parallel technical research streams + a 6-lens adversarial team review. Parent roadmap: [E2b governance core](./2026-07-12-e2b-governance-roadmap-design.md). This spec covers the **observation** slice (connect → commit candidate queue → pipeline detail) at implementable altitude, split into three PRs (3a/3b/3c).

## Product framing

Mocco = deploy-governance control plane on top of GitHub Actions. Core principle: **GitHub write permission ≠ production deploy permission**. Positioning: a lightweight, cheaper alternative to GitHub Environments "required reviewers" (paywalled behind Enterprise for private repos). DX angle: "show per-commit deploy candidates like Vercel, manage approval/deploy permissions like GitLab CI."

This is the **observation slice only**: connect GitHub → sync commits on a watched branch into a "candidate queue" (Vercel-deployments style) → parse each commit's `.mocco.yml` → show the pipeline's steps in a detail view. **NO execution, NO trigger (`workflow_dispatch`), NO approval/gate, NO Verify Action, NO audit** — those are later slices. GitHub is the **first "provider"** plugging into a provider-agnostic core (future: GitLab/Bitbucket), but **only GitHub is built now**.

Because this is a governance/multi-tenant product, two non-negotiables are folded in even at observation scope: (1) the App holds **read-only** authority (the whole thesis), and (2) an installation is bound to a workspace only after **proven ownership** — tenant isolation is a correctness property, not a later hardening.

`.mocco.yml` schema is fixed and lean per [ADR 0010](../../adr/0010-mocco-yml-lean-core-and-enforcement-invariants.md) — do **not** re-open: `{ version: 1, pipeline: <name>, steps: [{ run, executor, with? }] }`. One file = one pipeline. Environments/approvals arrive with the gate slices.

### Resolved decisions (were open questions after review)

1. **Uninstall retention** — `installation.deleted` **soft-deletes** the connection (status) and marks repos inactive; commit/config history is preserved for future audit/gate slices. Accepts unbounded historical growth + a status-aware query surface.
2. **OAuth-during-install collision** — none. The codebase has **no better-auth GitHub social provider** (login is email+pw only; env has `AUTH_*`/`DATABASE_URL` only). The App's install-time OAuth exchange is independent. When GitHub-as-identity-link lands later, reconcile by reusing that user token for `GET /user/installations` instead of a second exchange.
3. **Backfill bounds** — default **N=30** commits fetched on watch, hard ceiling **100** (a single page). Both live as named exports in `packages/backend/src/domain/integration/constants.ts` (`BACKFILL_DEFAULT_LIMIT`, `BACKFILL_MAX_LIMIT`), single source of truth.
4. **Env naming** — keep `GITHUB_*`. The `github` prefix names the **provider slug** (a first-class value in the provider `as const` union), not the isolated octokit SDK — consistent with the "env vars are ours, never vendor-branded" convention (which targets vendor product names like `BETTER_AUTH_*`, not domain values).
5. **Deferred sync** — ship best-effort `waitUntil()` deferred sync for launch; a durable `mocco_sync_jobs` table + Vercel Cron is documented as the escalation path but **not built now**. Recovery on mid-`waitUntil` teardown relies on GitHub redelivery + DB-unique idempotency.

## Architecture

- **Ports (domain, ISP, NO vendor imports)** — `RepoLister` (`listRepos`) consumed by `ConnectionService`; `CommitSource` (`listCommits`, `getConfigAtCommit`) consumed by `CommitSyncService` / `CommitConfigService`; `InstallationVerifier` (`verifyOwnership(code, externalAccountId) → { ownerVerified, accountLogin, githubUserId }`) consumed by the setup route. Narrow ports, one per consumer — not a god interface. The GitHub adapter implements the intersection. **`InstallationVerifier` exists specifically so the ownership path is fakeable** (a `FakeInstallationVerifier`) under the no-mock rule — without it the OAuth-code exchange + `GET /user/installations` call live only in adapter/route and have no seam to test against. **`WebhookParser` is not a port** (pure, no fake, no swap point yet); it lives on the GitHub adapter and is composed directly by the webhook route, tested against recorded fixtures.
- **Port method scoping** — methods take a **neutral connection reference** (the `Connection` or its `externalAccountId`). The adapter maps `externalAccountId → installation_id` internally and mints the token. One provider instance, connection passed per call — **no per-installation factory/resolver**.
- **GitHub adapter (`domain/integration/github/provider.ts`)** — the **only** file importing `@octokit/app`. Placed in **`domain`** at a leaf, following the existing vendor-isolation precedent (`domain/auth/provider.ts` wraps better-auth, `domain/pipeline/yaml/decode.ts` wraps the YAML lib) — a vendor is isolated *inside* domain at a single leaf without polluting the rest of the domain. Placing it in `infra` was considered and **rejected**: it would implement domain ports and `extends` `domain/errors.ts`, i.e. `infra → domain` imports, which violate Mocco's one-way layering (`transport → domain → infra`). Holds the module-scope `App`; per-installation auth via `getInstallationOctokit`; pure mappers `toCommit`/`toRepo`/`toConfigFile` returning neutral zod types (neutral-by-design, no raw octokit exposure, no escape hatch). Also exposes GitHub-specific `verify(rawBody, signature)` (boolean HMAC) and pure `parseWebhook`, and re-exports a safe octokit-error detector.
- **Errors (`domain/integration/github/errors.ts`)** — domain error classes extending the shared `domain/errors.ts` base (`ProviderConnectionRevokedError`, `RepoNotFoundError extends NotFoundError`, …). Octokit failures (401/403/410, rate-limit, network) are translated at the adapter boundary into these, carrying **only** `status` + a safe code/message — never the octokit object, headers, or request body (secret hygiene: octokit `RequestError` can carry the installation token). `404` from `getContent` is a normal empty outcome, not an error. Mapped per-router via a router-scoped tRPC middleware (`trpc.ts` stays generic). The Hono surface has its own explicit error→HTTP convention: never return vendor/SQL/internal detail to GitHub.
- **Services (constructor-injected)** — one service per slice concern:
  - `ConnectionService` [3a] — connect/list repos, set watched branch; neutral API accepts only `{ provider, externalAccountId, accountLogin }`; depends on `RepoLister`.
  - `CommitSyncService` [3b] — records commit rows into `mocco_commits` from a push event; depends on `CommitSource.listCommits` (backfill). **Does not touch config** — config is 3c.
  - `CommitConfigService` [3c] — fetches `.mocco.yml` at a commit SHA, parses it via the existing `MoccoConfigParser`, and snapshots into `mocco_commit_configs`; depends on `CommitSource.getConfigAtCommit`. This is where `getConfigAtCommit` is exercised, invoked from the deferred sync pass after commits are recorded.
  
  **No provider registry** — the `provider` column is stored, not dispatched on. The GitHub setup handshake (state, `setup_action`, `installation_id`, OAuth code exchange) stays entirely in the adapter + a GitHub-specific route — it never appears in a neutral service or `@mocco/common`.
- **Tenant-isolation invariant (`CommitSyncService` contract)** — `installation_id → connection (unique) → repo (by (connection_id, external_repo_id))` is the **only** resolution path. Never look up a repo by `external_repo_id` alone; assert the resolved repo belongs to the connection before any write; park webhooks whose `installation_id` has no owning connection. (One shared webhook secret authenticates the **app**, not the tenant; two tenants can legitimately watch the same public repo.)
- **Transport** — internal tRPC `integrationRouter` (connections, repos, commit queue, commit detail). External inbound gets its own **Hono** REST surface mounted under the **App Router** at `app/api/ext/[[...route]]/route.ts` via `hono/vercel handle()`. The "Pages Router, ALL-CSR" convention governs **frontend rendering only**, not backend route handlers; App and Pages routers coexist in Next.js. Mounting the raw-body webhook under Pages would let the bodyParser consume the stream before HMAC verify. Concrete ext paths (pinned, same in prod + local): setup callback `GET /api/ext/github/setup`, webhook `POST /api/ext/github/webhook`. Never expose tRPC externally.
  - **⚠️ This supersedes prior decisions and requires a new ADR.** [ADR 0011 — external API surface architecture] does **not exist yet**; it is the **first task of slice 3a** to author it as `docs/adr/0011-external-api-surface-architecture.md` (English, kebab, zero-padded). It records: (1) ext surfaces live on the **App Router** (not the Pages Router, reversing roadmap [§8](./2026-07-12-e2b-governance-roadmap-design.md) which mounts at `pages/api/ext/[[...route]].ts`, and resolving roadmap §10 open-Q3); (2) the concrete ext paths above (reconciling ADR 0006's `/api/webhooks/github` and the roadmap's `/api/ext/webhooks/github`); (3) the local dev tunnel target `hooks.mocco.club` as a **recorded exception** to ADR 0006's `mocco.work = local` split (because `mocco.work` is not on public DNS while `mocco.club` is already on Cloudflare — see the earlier connect-tunnel decision). Until ADR 0011 is authored + linked, treat the App-Router mount as decided-here-pending-ADR, not delegated to a missing doc.
- **Neutral types (zod SSOT in `@mocco/common`)** — `Connection`, `Repo`, `Commit`, `ConfigFile`. **`WebhookEvent` is not neutral** — the GitHub-namespaced event schema lives next to the GitHub adapter until a 2nd provider forces a neutral shape (`installation`/`installation_repositories` are GitHub-App taxonomy with no GitLab analogue). Neutral field naming stays GitLab-litmus'd: `defaultBranch` not `default_branch`, generic `sha`/`revision`. `owner`/`name` are display-only; `externalRepoId` is the identity used in all joins/uniqueness (GitLab's nested namespaces will not fit a flat owner/name).

## Data model

`mocco_` prefix, uuid PK generated in DB, explicit FK + `onDelete`, per-slice drizzle migration.

**`mocco_provider_connections`** [3a] — `id, workspace_id, provider, external_account_id, account_login, status, created_at`
- github external ref = `installation_id`; `status` = `as const` union (`active | suspended | deleted`).
- `uniqueIndex(provider, external_account_id)` — both write paths (state-verified callback, `installation.created` reconcile) upsert onto one row.
- `CHECK(provider)` matching the `as const` union (mirrors `mocco_members_role_check`).
- `uniqueIndex(id, workspace_id)` — backs the repos composite FK.

**`mocco_repos`** [3a] — `id, workspace_id, connection_id, external_repo_id, owner, name, default_branch, watched_branch, status, connected_at, last_synced_at`
- `connection_id → connections.id ON DELETE CASCADE`.
- `(connection_id, workspace_id) → connections(id, workspace_id)` — drift guard for the denormalized `workspace_id` (kept for hot workspace-scoped listing).
- `uniqueIndex(connection_id, external_repo_id)` — all ingestion upserts on it.
- **`provider` column dropped** (derivable via connection).
- `watched_branch` **nullable** (null = connected-but-not-watching / paused; enables unwatch without delete).
- `owner`/`name` display-only; identity is `external_repo_id`.

**`mocco_commits`** [3b] — `id (uuid PK), repo_id, seq (bigserial), sha, branch, message, author_name, author_email, committed_at, synced_at`
- `repo_id → repos.id ON DELETE CASCADE`.
- `uniqueIndex(repo_id, sha)` — natural-key upsert; the real idempotency guarantee.
- `seq bigserial` = monotonic arrival cursor **and** newest-first sort key; `index(repo_id, seq DESC)`. Candidate queue orders by `seq DESC` and polls with `seq` as the opaque cursor. **Do not sort by `committed_at`** (git-author-controlled, non-monotonic across rebases/backdating).
- `branch` = provenance, == `watched_branch` at sync time; NOT a multi-branch membership model (a commit-branch join table is deferred to multi-branch watching).

**`mocco_commit_configs`** [3c] — `id, commit_id, raw_yaml, parsed_json, valid, validation_errors`
- `commit_id → commits.id ON DELETE CASCADE`, `uniqueIndex(commit_id)` — 1:1 config per commit per ADR 0010.
- **`config_hash` dropped** (verify/gate concept for a later slice). **`config_path` dropped** (always `.mocco.yml`).
- `parsed_json` kept: deterministic parse-at-sync snapshot makes the detail view a pure DB read and is the audit-grade snapshot future gates will want. `valid` derivable from `validation_errors` (empty = valid), kept denormalized only for indexed filtering.

**`mocco_github_connect_states`** [3a] — `state (PK/uniq), user_id, workspace_id, github_user_login, github_user_id, created_at, expires_at, consumed_at`
- Short TTL, bound to the authenticated user+workspace, atomically consumed on callback. Holds the initiating GitHub identity used to correlate the deferred `installation.created` reconciliation (3b).
- **Deliberately `mocco_github_` namespaced** (not neutral like `mocco_provider_connections`): the install handshake — server-issued `state`, `setup_action`, OAuth `code` exchange, `github_user_*` — is provider-specific with no cross-provider shape yet. A neutral connect-state table is introduced only when a 2nd provider's handshake exists to abstract against. This is the naming rule: neutral tables for provider-agnostic data, `mocco_<provider>_` for provider-specific handshake state.

**`mocco_webhook_deliveries`** [3b] — `id, provider, delivery_id (uniq), event_type, received_at` (+ retention/TTL note; grows unbounded)
- Written only **after** signature verification. Provider-neutral (`delivery_id`, not `github_delivery_id`).

**Retention on uninstall** — `installation.deleted` soft-deletes the connection (status) and inactivates repos; commit/config history is preserved (FK cascades apply only to hard deletes, e.g. workspace deletion).

## GitHub App tech

- **Manifest (version-controlled), READ-ONLY least privilege** — `Contents:read`, `Metadata:read`; subscribed events `push` / `installation` / `installation_repositories`; **nothing else** (no Actions/`workflow_dispatch`, no Deployments, no Checks:write, no Contents:write). A CI/checklist gate asserts the observation build's scopes contain **no write verbs**. Write scopes are added only in the execution slice via scoped re-consent. **"Request user authorization (OAuth) during installation" is enabled** (needed for ownership verification).
- **Dependencies** (all exact-pinned, no `^`/`~`) — direct-depend on `@octokit/app` only (auth-app/webhooks are transitive, exact-pinned by the lockfile). Read `error.status` rather than `instanceof RequestError` (no `@octokit/request-error` direct dep). Add `@octokit/plugin-throttling` + `@octokit/plugin-retry`, extending the Octokit created by `App`. Add `@vercel/functions` (for `waitUntil()`, [3b]) and `hono` (ext surface). octokit imports are confined to the single leaf adapter; `@vercel/functions` and `hono` to the transport/ext leaf. ESM-only, Node 22.
- **Env** (only `env.ts` reads `process.env`, zod-validated) — `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.
- **Private key** — convert PKCS#1→PKCS#8 **once offline** (`openssl pkcs8 -topk8 -nocrypt`), base64 that into `GITHUB_APP_PRIVATE_KEY_B64`. `env.ts` only base64-decodes and validates the PEM is already PKCS#8 (`BEGIN PRIVATE KEY`), rejecting PKCS#1 with a clear error. No runtime ASN.1 conversion; `env.ts` imports no crypto surface. (WebCrypto, used by newer `@octokit/auth-app`, imports only PKCS#8.)
- **Connect flow (3a)** — install URL carries a server-issued single-use `state` (persisted in `mocco_github_connect_states`, bound to user+workspace) — `installation_id` alone is spoofable on the setup URL and is never trusted. The setup callback is an **App-Router ext REST route** (not tRPC): load session → verify state belongs to the current user+workspace → atomically consume → exchange the OAuth `code` for a user access token → **verify `installation_id ∈ GET /user/installations`** (ownership proof; state alone is necessary but not sufficient) → persist the connection (upsert on the unique key). Only `setup_action=install` is supported in 3a; `setup_action=request` (no `installation_id`) shows a "pending approval" UI state and is reconciled via `installation.created` in 3b (matching sender to a pending state for that GitHub identity within TTL; else park unclaimed).
- **Token cache** — in-memory, 60min TTL, no shared/Redis store. Low cross-invocation hit rate on Vercel (per-container cache) is acceptable at observation scale; documented, revisit only if mint volume matters.
- **Webhook (3b)** — `verify(rawBody, signature)` (boolean HMAC-SHA256, **not** `verifyAndReceive`) FIRST → persist the delivery row (idempotent on `delivery_id`) → return **202 immediately** → run commit/config fetch in a deferred pass via `@vercel/functions waitUntil()` (isolated to one leaf). DB unique constraints (`uniq(repo_id, sha)`, `uniq(commit_id)`) are the real idempotency guarantee via upsert/on-conflict; delivery-id dedup is an optimization. Replay caveat (HMAC covers body not headers) documented for future mutating slices. GitHub marks a delivery failed after ~10s and retries — fast-ACK is mandatory.
- **Installation lifecycle (3b)** — `installation.deleted` → soft-delete connection + inactivate repos + stop minting tokens; `suspend`/`unsuspend` → flip status + raise a colocated domain error (not a crash) when a suspended install is hit; `installation_repositories` → **parse-and-log-only** (real repo-set add/remove reconciliation deferred). Token-mint 401/403 map to domain errors, never unhandled throws.
- **File at SHA** — `repos.getContent{ref:sha}` base64-decoded; `404` = no config (normal). **Backfill** — never unbounded `paginate()`; use `per_page ≤ N` (N ≤ 100) single page or `paginate.iterator()` with an explicit early break once N collected; hard ceiling in a shared constant; best-effort, watermarked by `last_synced_at`. Same discipline for config fan-out.

## Testing (NO mocks; pglite in-memory Postgres integration)

- `parseWebhook` is **pure** → test the real GitHub adapter against **recorded** GitHub webhook payload fixtures (captured from Recent Deliveries).
- Network reads (`listCommits`/`getConfigAtCommit`) faked via small role-interface fakes (e.g. `FakeCommitSource`) injected into services. No `vi.mock`, no `*ForTesting` — the injected dependency **is** the seam.
- Mapper outputs validated with zod `.parse()` in tests to catch schema drift.
- **Tenant-isolation test** — two tenants watching the same `external_repo_id`; assert a push for one never writes the other's rows.
- **Error-hygiene test** — mapped domain errors contain no `authorization`/`token` material.
- Ownership-verification and single-use/consumed-state paths covered as pglite integration tests by injecting a `FakeInstallationVerifier` (the `InstallationVerifier` port) into the setup route — no `vi.mock`, no real GitHub call. Assert: valid state + verified ownership → connection persisted; consumed/expired state → rejected; ownership-not-verified → no connection written.

## Slicing (one concern per PR; each deployed to Vercel + visibly running)

- **3a Connect & manage** — read-only App manifest; server-issued single-use state (`mocco_github_connect_states`); OAuth-during-install + ownership verification via `GET /user/installations`; App-Router ext callback route; `mocco_provider_connections` (uniq `provider+external_account_id`) + `mocco_repos`; dashboard shows **real** repos; per-repo watched branch (nullable). Only `setup_action=install`; request path shows pending. No commit webhook. **Testable locally WITHOUT a tunnel** (callback is a browser redirect to localhost).
- **3b Commit sync** — push/lifecycle webhook on the ext surface (needs a stable tunnel: cloudflared → `hooks.mocco.club`; recorded fixtures for CI); verify-first → `mocco_webhook_deliveries` → 202 → `waitUntil` deferred sync; `mocco_commits` (seq cursor, `uniq(repo_id, sha)`); bounded backfill on watch; candidate-queue UI; installation lifecycle (deleted/suspend/unsuspend status, `installation.created` reconciliation, `installation_repositories` log-only).
- **3c Config parse & detail** — `CommitConfigService`: per-commit `.mocco.yml` fetch/parse/snapshot (`mocco_commit_configs`, `commit_id` FK), throttled/deferred fetch; detail view reusing slice 1's pipeline-steps component (expected `packages/frontend/src/components/pipeline-steps.tsx`; confirm the final name/path at implementation time). **Prerequisite: slice 1 (`.mocco.yml` preview, branch `feat/pipeline-preview`) must be merged to main first** — it provides the component and the `MoccoConfigParser` + `@mocco/common/mocco-config` schema this slice reuses. (Not present on the current working branch.)

## Out of scope (later slices)

Execution/trigger (`workflow_dispatch` + `ref`/`commit_sha` split), approval/gates + roles, Verify Action + approval tokens, audit hash-chain, credential broker, multi-branch watching, `installation_repositories` repo-set reconciliation, durable sync jobs (`mocco_sync_jobs` + Cron), a neutral cross-provider `WebhookEvent`, and a second provider (GitLab/Bitbucket).
