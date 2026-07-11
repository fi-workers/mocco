---
title: E2b — Pipeline governance core (design & slice roadmap)
type: design-spec
status: draft
created: 2026-07-12
owner: andrea
related:
  - ../../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../../adr/0004-executor-agnostic-core-with-adapter-contract.md
  - ../../reference/mocco-yml-spec.md
---

# E2b — Pipeline governance core: design & slice roadmap

> Synthesized from a four-lens architecture pass (domain/data-model · `.mocco.yml` schema · executor/enforcement · API/frontend/deploy). This spec covers the **whole E2b roadmap** at design altitude and specifies **slice 1** in implementable detail. Each later slice gets its own plan when it comes up.

## 1. Purpose & scope

Mocco is a **pipeline governance control plane** — "write ≠ deploy". E2a shipped the shell (auth, workspaces, tRPC, Pages Router, packages/ layout). E2b makes **pipelines real and observable**, then layers governance on top, **basics first**.

**Guiding principles (user-set):**
- Build the **basics first** — define / view / trigger / observe workflows — before governance (gates) and enforcement.
- **Each slice is self-contained AND deployed to Vercel AND visibly running** (not just unit-tested).
- **Modular, one concern per PR.**
- **No hard external dependency in the early core.** Heavy externals (GitHub App, cloud STS) are opt-in adapters in later slices.
- The `.mocco.yml` schema is a first-class early artifact (the definition source).

## 2. Confirmed decisions

| # | Decision | Choice |
|---|---|---|
| 1 | External REST surface (executor callbacks/webhooks) | **Hono mounted inside Next** as a fetch handler (like better-auth), one deployment. Reconciles ADR 0005 (no *separate* server) — external inbound gets its own REST surface (AGENTS.md: never expose tRPC externally), distinct from internal tRPC. Relevant from slice 2; slice 1 adds no external surface. |
| 2 | Generic executor topology (slice 2) | **No always-on worker.** Trigger = a serverless `fetch`; the generic executor = a serverless function invoked to run a trivial step and POST a callback; callback = a serverless endpoint. Cron+outbox is a **deferred reliability option**, not built now. |
| 3 | Production Postgres | **Supabase** (MCP present here; Supavisor pooler `:6543` + `max:1` for serverless; Realtime as a future push-upgrade path). Separate `DIRECT_URL` `:5432` for migrations. |
| 4 | Credential broker / cloud STS | **Excluded from E2b** — deferred to a later "bypass-proof enforcement" phase. See §10. Consequence: the gate (slice 4) enforces via **Mocco dispatch control** (orchestration-level), not credential-gating. `.mocco.yml` gains **no `credential` field** in E2b. |

**Cross-cutting defaults baked in** (raised by the architects, resolved here): `repo_id` on pipelines is nullable until slice 3; a run **pins `pipeline_version_id`** at creation so config-hash mismatch is impossible by construction; the per-run **callback token** is opaque + stored as sha-256, verified against the DB; the audit hash-chain is **per-workspace**; the live-run poll uses a `sinceSeq` cursor over `run_events`.

## 3. Converged architecture

Three layers, all executor/vendor-neutral (ADR 0004), workspace-scoped.

```
   Browser ── SSR (getServerSideProps, in-process backend via createCaller)
      │
      ├─ /api/trpc/*   internal, session-authed (frontend↔backend)   → domain services
      ├─ /api/auth/*   better-auth (existing)
      └─ /api/ext/*    external, token-authed (Hono-in-Next)          → domain services
             · POST /runs/:id/callback   executor reports status/done → RunService.applyCallback
             · GET  /health
             · (slice 3) POST /webhooks/github   GitHub adapter → same applyCallback

   Outbound trigger = a server-side fetch inside RunService (NOT a route).
   applyCallback is the single funnel: generic executor (slice 2) and GitHub (slice 3) converge on it.
```

**Definition vs execution split (the core shape):** a `.mocco.yml` is stored as an **immutable version snapshot** (`raw_yaml` + parsed `definition` jsonb + `content_hash`); the steps/gates live inside that JSON (authored & reviewed atomically, never queried cross-pipeline). **Execution progress is normalized** (`run_steps`, later `run_gates`) because each row is mutated independently by callbacks and rendered per-row.

**Two authority axes (never conflated):** better-auth org roles (`owner/admin/member` — workspace administration) vs **governance roles** (`mocco_roles`: `sre`, `security`… — who may resume a gate). Governance roles are a separate store, referenced by **name** from `.mocco.yml`.

**Conventions honored:** zod single-source in `@mocco/common`; `mocco.schema.json` **generated** from zod (drift-checked); constructor-injected service classes + one composition root (`auth/instance.ts`); vendor isolation (one boundary file per vendor — YAML decoder, GitHub SDK); thin transports (parse → delegate); `mocco_` tables, uuid PKs; per-slice drizzle migration.

## 4. Slice roadmap

| # | Slice | DB migration | Backend | Frontend (deployed + visible) | External work |
|---|---|---|---|---|---|
| **1** | `.mocco.yml` **define / view** | `pipelines`, `pipeline_versions` | `PipelineService` (parse→validate→persist); YAML vendor boundary; schema in `@mocco/common` | submit-yaml form + pipeline list/detail (parsed steps) | Vercel + Supabase (you) |
| **2** | **trigger + generic executor + live run** | `runs`, `run_steps`, `run_events` | `RunService` (trigger, applyCallback, observe), neutral executor contract, Hono `/api/ext` callback, generic executor fn, callback token | trigger button + **live run timeline** (poll `sinceSeq`) | none |
| **3** | **GitHub Actions adapter** | `github_installations`, `repos` (+`pipelines.repo_id`) | `executors/github/*` (vendor-isolated), `POST /webhooks/github` (signature-verified) → same `applyCallback` | step rows show `github-actions` + logs link-out | GitHub App + tunnel (you) |
| **4** | **gates / approval** | `roles`, `role_memberships`, `run_gates`, `resumes`; runs state adds `awaiting_gate`/`rejected` | `GateService` (N-of-M AND, `prevent_self`, `reason`), `RoleService` | gate card (progress + Approve/Reject), Access (role↔member) page | none |
| **5** | **audit** | `audit_log` (bigserial, hash chain, per-workspace) | `AuditService` (append + verify); write-path emits events from slices 2/4 | audit table + chain-intact badge | none |
| *(deferred)* | *credential broker + cloud STS* | *`credential_grants`, `credential_tokens`* | *`CredentialBroker` (stub→AWS OIDC), `.mocco.yml` gains `credential`* | *step shows issued / DENIED (bypass-proof demo)* | *AWS OIDC (you)* |

**Enforcement strength note:** without the deferred credential broker, a gate is an **orchestration gate** — Mocco won't dispatch the gated step until N-of-M resume. Fully effective for Mocco-triggered runs (the generic executor). For GitHub, a *manual* `workflow_dispatch` outside Mocco could bypass it; that hole closes only when the credential broker lands (feature-map: credential gating is what makes the gate un-bypassable). Accepted as a deliberate staging.

## 5. Data model (per-slice)

All tables: `mocco_` prefix, `uuid().primaryKey().defaultRandom()` (audit log excepted — `bigserial` for monotonic chain), shared `createdAt`/`updatedAt`, cascade from `mocco_workspaces`, `workspace_id` on every table (direct scoping), service-layer enforcement (no RLS).

**Slice 1**
- `mocco_pipelines` — `id`, `workspace_id`→ws cascade, `repo_id` (nullable until s3), `name`, timestamps; `uniqueIndex (workspace_id, name)`.
- `mocco_pipeline_versions` — `id`, `workspace_id`, `pipeline_id`→pipelines cascade, `source_commit_sha` (nullable), `raw_yaml` text, `definition` jsonb (parsed, validated tree), `content_hash` text (sha-256 of canonical `definition`), `created_at`; `uniqueIndex (pipeline_id, content_hash)` (idempotent re-parse).

**Slice 2**
- `mocco_runs` — `id`, `workspace_id`, `pipeline_id`, `pipeline_version_id`→versions **RESTRICT** (never orphan the pinned definition), `commit_sha` (branded), `state` text CHECK (`queued|running|succeeded|failed|canceled`; gate states added s4), `current_index` int (cursor into `definition.steps`), `triggered_by_user_id`→users set null, `trigger_source` text, `callback_token_hash` text, `started_at`/`finished_at`, timestamps; indexes on workspace/pipeline/state, unique callback_token_hash.
- `mocco_run_steps` — `id`, `workspace_id`, `run_id`→runs cascade, `step_index` int, `name`, `executor`, `with` jsonb, `status` text CHECK (`pending|dispatched|running|succeeded|failed|skipped|canceled`), `handle` text (opaque adapter handle — keeps GitHub words out of core), `logs_url` (nullable), timestamps; `uniqueIndex (run_id, step_index)`.
- `mocco_run_events` — append-only progression log driving the live view (and the audit source in s5): `seq` (bigserial or `(run_id, ordinal)`), `run_id`, `type`, `payload` jsonb, `created_at`.

**Slice 3** — `mocco_github_installations` (`installation_id`, `workspace_id`), `mocco_repos` (`workspace_id`, provider, external_id, owner, name, installation_id); ALTER `pipelines` set `repo_id`, uniq → `(workspace_id, repo_id, name)`.

**Slice 4** — `mocco_roles` (`workspace_id`, `name`; uniq `(workspace_id, name)`), `mocco_role_memberships` (`role_id`, `user_id`; uniq `(role_id, user_id)`), `mocco_run_gates` (`run_id`, `step_index`, `name`, `state` `pending|resumed|rejected|expired`, `requirements` jsonb snapshot; uniq `(run_id, step_index)`), `mocco_resumes` (`run_gate_id`, `run_id`, `user_id` RESTRICT, `role_id`, `decision` `resume|reject`, `reason`; uniq `(run_gate_id, user_id)` — one vote/person/gate). `prevent_self` enforced in the service.

**Slice 5** — `mocco_audit_log` (`seq` bigserial PK, `id` uuid unique, `workspace_id`, `actor_user_id` set null, `action`, `subject_type`, `subject_id`, `payload` jsonb, `prev_hash` nullable, `hash` NOT NULL = sha-256(`prev_hash || canonical(row)`); `index (workspace_id, seq)`).

**Run state machine (s2 core, extended s4):** `queued → running` (dispatch step 0); on step-callback `succeeded` → advance cursor: next is a step → dispatch; next is a gate → `awaiting_gate` (s4); none left → `succeeded`. `failed` on step failure. `awaiting_gate → running` when N-of-M met; `→ rejected` on reject. `canceled` by operator. Every transition appends a `run_event` (→ audit in s5).

## 6. `.mocco.yml` schema

New `packages/common/src/mocco-config.ts`, exported via `"./mocco-config"`. zod is the **single source**; `docs/reference/mocco.schema.json` is **generated** (`z.toJSONSchema`, draft 2020-12) and drift-checked in CI (clone `scripts/drift-check.sh`).

**v1 basics (slice 1):**
```ts
const stepWithSchema = z.record(z.string(), z.unknown());          // free-form, adapter-owned (no GitHub words in core)
const stepSchema = z.object({ run: z.string().min(1), executor: z.string().min(1), with: stepWithSchema.optional() }).strict();
const pipelineItemSchema = stepSchema;                              // widened to union(step, gate) in slice 4
const moccoConfigSchema = z.object({
  version: z.literal(1),
  pipeline: z.string().min(1),
  steps: z.array(pipelineItemSchema).min(1),
}).strict();
```
- `.strict()` everywhere except `with` — typos fail loudly (governance control plane; silent drift is the enemy). `with` is the one escape hatch (adapter keys).
- `executor` is an **opaque string**, not an enum — adapters are pluggable (ADR 0004); validity is an adapter-registry runtime concern, not a file-format one.
- **Additive evolution, `version` stays 1:** gates (s4) widen `pipelineItemSchema` to `z.union([step, gate])` + a `.superRefine` for index-precise "neither step nor gate" errors; concurrency/safety/preconditions/audit are optional top-level keys added when their slices land. A `version: 2` (discriminated-union wrapper) is introduced only at the first *breaking* change. **No `credential`** in E2b (deferred).
- **Parse boundary:** tRPC `pipeline.submit(source)` → `MoccoConfigParser.parse` (backend `pipeline/` domain): YAML decode (the only `yaml`-importing module → domain `MoccoConfigYamlError` with `cause`+line) → `moccoConfigSchema.safeParse`. Returns a discriminated `ParseResult` (`{ok:true, config}` | `{ok:false, stage, issues:[{path,message,code,line?}]}`) so the UI shows all errors at once.
- **Open (bake in):** step/gate `name` unique within a pipeline (`.superRefine`) — yes (runs/audit key on it). Executor-id validity deferred to the trigger layer (schema accepts any string).

## 7. Executor contract & the generic executor

Neutral interface (`Executor`: `start/poll/logs/cancel`); wire payloads as zod in `@mocco/common/executor.ts` (branded `RunId`/`StepName`/`CommitSha`).
- **Trigger (outbound)** `{run_id, step, commit_sha, token, callback_url}` — fire-and-forget `fetch` from `RunService`. Harmless if replayed: enforcement is downstream.
- **Callback (inbound)** `POST /api/ext/runs/:id/callback`, `Bearer <token>`, `{run_id, step, status: running|succeeded|failed, done, logs_url?}` → `RunService.applyCallback` advances the FSM; idempotent on `(run_id, step, status)`.
- **Token:** opaque 32-byte base64url, minted at trigger, **stored sha-256 only**, verified by hash + run/step match + unexpired; reusable for status posts, closed on terminal `done`. (Credential single-use token is deferred with the broker.)

**Generic executor (slice 2)** = a **serverless function** (no always-on worker) that receives the trigger, "runs" a trivial bounded step (sleep + emit progress, or a whitelisted built-in action), and POSTs the callback. Proves the trigger→execute→callback→advance loop end-to-end with **zero external accounts**. Local dev: reachable directly. Hosted: it's a Vercel function; if background-invocation reliability becomes an issue, add the ADR-0005 outbox+Cron drain later (deferred).

**GitHub adapter (slice 3)** — `executors/github/provider.ts` is the only GitHub-SDK importer: `start`→`repository_dispatch` (`client_payload` carries the trigger fields), `mocco/verify@v1` posts the **same** neutral `/callback`, `workflow_run` webhook → `/webhooks/github` (signature-verified) → **same** `applyCallback`. Core never learns `workflow`/`repository_dispatch`.

## 8. API surfaces & frontend per slice

**tRPC (internal):** `pipeline.submit|list|get` (s1); `run.trigger|get|list` (s2, `run.get` = poll target); `gate.resume|reject`, `role.list|assign|unassign` (s4); `audit.list|verifyChain` (s5). Each = a merged router in `root.ts` backed by one injected service; add each service to `Services`/`getServices()` + tRPC `Context` + both context builders.

**Hono (external):** `/api/ext/*` via `packages/backend/src/http/{app,handler}.ts` (Hono imported here only; `nodeHandler` bridge like `toNodeAuthHandler`) mounted at `packages/frontend/src/pages/api/ext/[[...route]].ts` (`bodyParser:false`, Node→Web Request bridge reusing `headersFromNode` + raw body). Coexists with `auth/*` and `trpc/*` by path.

**Frontend (each page = the `account.tsx` idiom: gSSP session-gate + `createCaller` initial data; vanilla `lib/trpc.ts` client; React Compiler on):**
- s1: `pages/pipelines/{index,new,[id]}.tsx` — list, submit-yaml form (inline zod parse errors = the UX), parsed **step** detail (v1 has steps only; gate rendering arrives in slice 4).
- s2: Trigger button on `[id]`; `pages/runs/[id].tsx` gSSP initial + `run-progress.tsx` polling `run.get({sinceSeq})` every ~1.5s, **stopping on terminal** (arrow-fn effect, interval callback sets state → no `set-state-in-effect`).
- s4: gate card (AND-progress + Approve/Reject, `prevent_self` hides button for triggerer) on the run page; `pages/access/index.tsx` role management.
- s5: `pages/audit/index.tsx` (chain-intact badge).

## 9. Deployment

Vercel (Next Pages Router, Root Directory `packages/frontend`, install at repo root for yarn workspaces, `transpilePackages` already pulls backend in-process) + **Supabase Postgres**. Env (in `env.ts` zod, the only reader): `DATABASE_URL` (pooled `:6543`, `Pool max:1`), `DIRECT_URL` (`:5432`, migrations only — `drizzle.config.ts` uses it), `AUTH_SECRET`, `AUTH_URL` (must match origin). **Migrations run CI-gated on merge to main** (`yarn db:migrate` against `DIRECT_URL`, or Supabase MCP `apply_migration`) — never inside the Vercel build. Domains (ADR 0006): prod `www.mocco.club`; preview `*.vercel.app` (add to better-auth `trustedOrigins`, derive `AUTH_URL` from `VERCEL_URL`); local `dev.mocco.work` (cloudflared tunnel, receives s3 GitHub webhooks). **Live-run observability = SSR initial + client poll** (serverless-honest; Supabase Realtime on `run_events` is the documented, not-built, push upgrade).

## 10. Deferred & open questions

**Deferred (post-E2b):** credential broker + `CredentialProvider` (stub→AWS OIDC STS) and the un-bypassable enforcement it brings; the `.mocco.yml` `credential` field; outbox+Cron executor reliability; org-level override file (monotonic hardening); concurrency modes; `allowed_to_deploy` dispatch-authority list.

**Open (for the user, non-blocking for slice 1):**
1. Repo/connect flow: confirmed `.mocco.yml` is pasted/uploaded in s1 (repo_id nullable until s3). ✓ assumed.
2. Preview DB: shared persistent vs Supabase branch-per-PR? (decide before first deploy)
3. Webhook path: `/api/ext/webhooks/github` (single Hono mount) vs ADR-0006's `/api/webhooks/github` (may need a superseding ADR).

## 11. Slice 1 — detailed spec (first implementable unit)

**Goal (visible, complete, deployed):** on the live Vercel URL, a signed-in user pastes a `.mocco.yml`, Mocco parses & validates it, stores it, and the user sees the parsed pipeline (name + ordered steps) in their workspace.

**Deliverables:**
1. `@mocco/common/mocco-config.ts` — v1 zod (§6) + inferred types + `"./mocco-config"` export; `scripts/gen-mocco-schema.mjs` regenerates `docs/reference/mocco.schema.json`; a `schema:drift` CI check. **Note:** the current committed `mocco.schema.json` is hand-written and fuller (gate/credential/concurrency/…); slice 1 **overwrites it** with the narrower generated v1-basics schema. The plan must also add a note to `docs/reference/mocco-yml-spec.md` that gate/credential/etc. are **not yet in the generated schema** (so its full example and the drift check don't silently diverge).
2. `packages/backend/src/pipeline/` — `MoccoConfigParser` (constructor-injected; YAML decoder dependency), `yaml/decode.ts` (only `yaml` importer; domain `MoccoConfigYamlError`), `errors.ts`, `PipelineService`. **`submit(source)` flow:** resolve the caller's active workspace (as `WorkspaceService.active()` does) → parse+validate → **upsert `pipelines` by `(workspace_id, name)`** (name = `config.pipeline`) → **insert a `pipeline_versions` row deduped on `content_hash`** (re-submitting an unchanged file is idempotent — returns the existing version). `list`/`get` are workspace-scoped.
3. DB migration — `mocco_pipelines`, `mocco_pipeline_versions`.
4. tRPC `pipelineRouter` (`submit`/`list`/`get`), merged in `root.ts`; `PipelineService` wired into `Services`/`getServices()`/`Context`.
5. `@mocco/common` `PipelineDto`/`PipelineVersionDto` (egress via `.output()`).
6. Frontend: `pages/pipelines/{index,new,[id]}.tsx` + `components/pipeline-yaml-form.tsx`, `pipeline-steps.tsx`.
7. Deploy: Vercel project + Supabase DB + env + CI migrate.

**Tests:** zod parse (valid + each invalid class), `MoccoConfigParser` (YAML syntax error → domain error with line; schema error → issues), `PipelineService` on pglite (submit → list → get; idempotent re-submit dedups), Playwright e2e (paste yaml → see parsed pipeline; extends the existing suite).

**Dependencies to add (pinned):** `yaml` (backend). No other new runtime deps for slice 1.

**External work (you), parallelizable:** create the Vercel project (Root Directory `packages/frontend`) + Supabase project; provide `DATABASE_URL`/`DIRECT_URL`/`AUTH_SECRET`/`AUTH_URL`. The code lands and is unit/e2e-green regardless; the deploy step needs these.
