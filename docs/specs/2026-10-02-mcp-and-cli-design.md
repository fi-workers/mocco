---
title: Mocco MCP server and CLI — scope and design
description: How agents and terminals reach Mocco — a stateless remote MCP server on the 2026-07-28 revision, authenticated as a person through Better Auth's OAuth, a /v1 read surface for keys, and one npx-able mocco CLI that absorbs mocco-ota — starting with governance, where an approval must be attributable to a human.
type: spec
status: draft
created: 2026-10-02
updated: 2026-10-05
confidence: medium
owner: andrea
tags: [spec, design, mcp, cli, governance, api, oauth, security]
phase: design
implements: ../adr/0002-mocco-is-an-independent-authorization-layer.md
related:
  - ../adr/0003-core-model-is-pause-resume-gates-no-env.md
  - ../adr/0011-external-api-surface-architecture.md
  - ../adr/0017-public-v1-api-keys-and-sdk-licensing.md
  - ../adr/0020-approvals-outside-pipeline-runs.md
  - ../reference/public-api.md
  - ../reference/approvals.md
---

# Mocco MCP server and CLI

An agent writing code is already the thing that opens the pull request, watches CI and
asks to deploy. Today it cannot see any of that in Mocco: the console is tRPC-only, and
`/v1` carries flags, messenger and OTA but nothing about runs or gates. So the one
question a developer actually asks an assistant — *"is the deploy stuck, and on what?"* —
has no answer, and the one action that matters — *"approve it"* — has no surface.

This is the design for both surfaces. It starts with governance because that is the
product, and because governance is where the hard constraint lives.

## The constraint that shapes everything

**An approval cannot be made by an API key.**

[ADR 0002](../adr/0002-mocco-is-an-independent-authorization-layer.md) makes Mocco an
authorization layer in its own right: who may resume a run is a Mocco role, not a GitHub
permission. `ApprovalService.vote` takes a `userId` and checks that person's role
memberships; the audit chain records them. A key has no person behind it — our
`ApiKeyPrincipal` carries a project and scopes, nothing more — so letting a key approve
would turn "write ≠ deploy" into "whoever holds this string may deploy", which is the
failure the product exists to prevent.

This is also the **confused deputy** problem, which the MCP security literature names as
the central risk of the whole protocol: a server that acts with its own broad privileges
on behalf of a user who lacks them lets a low-privilege caller — or a model that has been
talked into it — reach actions they were never entitled to. The mitigation is not a
filter in the MCP layer. It is that every tool calls the same service the console calls,
with the caller's own `userId`, and that service's role check is the only authority. The
MCP server holds no privilege of its own to be confused about.

So the split is:

| | Authenticates as | May do |
|---|---|---|
| `/v1` + API key | a **project** | read runs and their steps and gates (approvals: see below) |
| MCP + OAuth | a **person** (their roles) | everything a key may, plus approve, reject and resume |
| CLI | a person (device login), or a key for CI | both, depending on how it authenticated |

The MCP server is therefore not a convenience wrapper over `/v1`. It is the only surface
outside the console where a governance decision can legitimately be made, because it is
the only one that knows who is asking.

## The protocol has moved: 2026-07-28

MCP went **stateless** in the 2026-07-28 revision, and the changes are not cosmetic:

- `initialize`/`initialized` and the `Mcp-Session-Id` header are gone. Every request
  carries its protocol version, client identity and capabilities in `_meta`, so any
  request can land on any instance behind a plain round-robin load balancer. This suits
  our serverless deployment exactly — there is no session store to run.
- Only **POST** is served. A server on this revision ignores an incoming
  `Mcp-Session-Id`, never mints one, and answers GET and DELETE with `405`.
- `Mcp-Method` and `Mcp-Name` headers are mandatory, so a gateway can route and meter
  without parsing bodies.
- **Multi Round-Trip Requests (MRTR)** replace server-initiated requests. When a tool
  needs something from the human mid-call it returns `resultType: "input_required"` and
  the client retries with `inputResponses`. See *Human in the loop* below — for us this
  is not a migration detail, it is the confirmation step.
- Authorization hardened: `iss` must be returned and validated (RFC 9207), clients set
  `application_type` at registration, credentials are bound to their issuing
  authorization server, and **Dynamic Client Registration is deprecated in favour of
  Client ID Metadata Documents (CIMD)**.
- The legacy HTTP+SSE transport is deprecated with a twelve-month window.

We are building new, so we serve this revision only (`legacy: "reject"`) rather than
carrying a compatibility path we would have to delete within the year.

## Authentication: Better Auth already has it

Mocco's auth is vendor-mediated through Better Auth
([backend conventions](../reference/backend-conventions.md) — only
`domain/auth/provider.ts` may import it). Better Auth 1.7 covers this whole design, so
**no OAuth server is written here**:

```ts
// domain/auth/provider.ts — the only file that may import these
import { jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';

plugins: [
  jwt(),
  cimd({ metadataProfile: 'mcp-2026-07-28' }),
  mcp({ loginPage: '/sign-in', consentPage: '/consent', resource: 'https://<host>/api/mcp' }),
]
```

`mcp()` is the OAuth 2.1 authorization server and serves the RFC 9728 protected-resource
metadata; `oauthProvider()` is **not** registered separately. `cimd()` provides the
2026-07-28 client-registration flow that replaces DCR. `requireMcpAuth(auth, handler,
{ resource })` verifies the bearer token against the JWKS and hands the session to the
handler, so a tool receives a `userId` the same way a tRPC procedure does.

Its `requiredScopes` option triggers **step-up authorization** when a token lacks a
scope. That is the right shape for `approvals:write`: an agent reads with the token it
has, and the human is asked to grant the deciding scope at the moment a decision is
actually wanted.

**Prerequisite:** the repository is on Better Auth 1.6.23, whose MCP plugin is the
pre-2026-07-28 API (`withMcpAuth`, no CIMD). Upgrading to 1.7.x is its own slice —
auth is load-bearing, and an auth upgrade reviewed alongside a new surface is an auth
upgrade nobody reviewed.

### What we will not do

- **No token passthrough.** The spec forbids an MCP server forwarding a client's token to
  a downstream API, because it bypasses that API's scope checks, limits and logs. Our
  tools call domain services in-process, so there is no downstream to forward to — and if
  one appears (a vendor integration), it gets its own separately-scoped credential.
- **No token we are not the audience of.** Tokens are bound to the `resource` above and
  refused otherwise, so a token minted for another MCP server cannot be replayed at ours.

## Where it mounts

[ADR 0011](../adr/0011-external-api-surface-architecture.md) puts external inbound
surfaces on the App Router and keeps tRPC for the console. MCP is external inbound:

```
packages/backend/src/
  transport/mcp/tools/*.ts     one file per tool group; parses, calls one service
  transport/mcp/server.ts      registers the tools, maps domain errors to messages
  transport/ext/v1/runs.ts     the read endpoints a key may call
  runtime/mcp.ts               composition root: builds the server from the domains
packages/frontend/src/
  app/api/mcp/route.ts         POST only, requireMcpAuth + createMcpHandler(legacy: 'reject')
packages/cli/                  @mocco/cli — `npx mocco …`
```

The handler is composed in `runtime/`, like the job runner: it sits above the domains and
the domains do not know it exists.

## The tools

Named `mocco_<domain>_<verb>`, because a prefix is what keeps tools legible once a model
has several servers loaded.

**Reading** — available to a key and a person alike:

| Tool | Answers |
|---|---|
| `mocco_runs_search` | Which runs match a filter (project, status, ref, time) |
| `mocco_runs_get` | One run: steps, gates, why it is paused |
| `mocco_approvals_search` | What is waiting on a human, and on whom |
| `mocco_approvals_get` | One request: subject, policy, votes, who may still vote |
| `mocco_flags_search` | A project's flags matching a filter (text, lifecycle, repo-managed) |
| `mocco_flags_get` | One flag: variants, per-environment state, whether the repo manages it |
| `mocco_flags_changesets_search` | Flag changes waiting for approval, with the request deciding each |

**Deciding** — person only, refused for a key with a message saying why:

| Tool | Does |
|---|---|
| `mocco_approvals_vote` | Approve or reject with a reason |
| `mocco_gates_resume` | Resume a paused run, when the caller's role allows it |

### Search, not list

Anthropic's tool-design guidance is blunt about this: a tool that returns everything is
"a disaster for agents", because the model pays for every row in context before it can
find the one it wanted. So the read tools are **search with filters and paging**, never
a bare dump, and every one takes a `response_format` of `concise` or `detailed` so the
model can ask for ids and statuses first and the full step list only once it knows which
run it cares about.

### What a tool must not do

A tool is a thin adapter, exactly as a tRPC router is
([backend conventions](../reference/backend-conventions.md)). It parses its input, calls
**one** service, and maps domain errors to a message the model can act on. No tool
composes a decision out of several services, and no tool has a code path the console does
not. If an agent can do something through MCP that a person cannot do in the console,
that is a hole in the model, not a feature of MCP.

Every mutating tool is audited through the same service that audits the console, so the
audit chain cannot tell whether a vote arrived from a browser or an agent except by the
principal it records. That is deliberate: the evidence must be uniform.

## Human in the loop, and read-only by default

Prompt injection succeeds when tool calls execute silently. The standard mitigation is a
confirmation that shows the human exactly what is about to happen — and MRTR is the
protocol's own mechanism for it: `mocco_approvals_vote` returns
`resultType: "input_required"` with the run, the gate and the policy it is about to
satisfy, and only applies the vote when the retry carries the human's confirmation.

Separately, the server runs **read-only unless told otherwise**. Supabase's
`read_only=true` has become the reference pattern here, and for a surface whose mutating
tools approve production deploys the default has to be the safe one. A workspace that
wants agents to decide opts in; everyone else gets the four read tools and nothing that
can deploy.

These are not alternatives to the role check. They sit in front of it, and the role check
still refuses what the role refuses.

## Scopes

| Scope | Grants |
|---|---|
| `runs:read` | List and read runs, steps and gates |
| `approvals:read` | List and read approval requests and their votes |
| `approvals:write` | Vote and resume. **Only ever on a person's token, never on an API key** |

`approvals:write` existing as a scope and being unavailable to keys is the point: the
model stays uniform and the refusal is one check in one place, rather than a shape the
key system cannot express. It is also the scope `requiredScopes` steps up for.

## The CLI

**One `mocco`, run with `npx`.** `mocco` becomes `mocco ota …` and stays as a
deprecated alias for the builds that already call it. Two CLIs for one product is a
question every user has to answer before they can use either.

```bash
npx mocco login                       # device code; a token per profile
npx mocco runs list --project acme
npx mocco gate approve <id> --reason "checked the migration"
npx mocco ota publish --channel production   # what mocco ota publish is today
```

Two ways to authenticate, because the CLI has two callers:

- **A person**, through `mocco login`. The OAuth 2.0 Device Authorization Grant
  (RFC 8628) is the fit — Vercel made it their CLI default in 2025 — and it is also the
  only flow that works where a browser cannot be opened, which includes an agent in a
  sandbox. Loopback + PKCE is the safer choice when a browser *is* available, so the
  login tries that first and falls back to the device code.
- **CI**, through `MOCCO_API_KEY` or GitHub OIDC, exactly as `mocco` does now. It can
  publish and read; it cannot approve, and says so plainly if asked to.

The polling loop is where device-flow implementations usually go wrong: honour the
server's `interval`, back off on `slow_down`, stop at `expires_in`, and report
`access_denied` and `expired_token` as themselves rather than as a generic failure.

The CLI is a client of the same endpoints with no logic of its own — the third consumer
of one contract, not a third contract.

## Slices

Each is a PR, in dependency order. The first two are useful on their own: they are the
public read API for runs, which any dashboard or SDK wants regardless of MCP.

1. **`/v1` run reads** — `runs:read`, `GET /v1/runs` and `GET /v1/runs/{id}`, scoped to
   the repositories the key's project links. No MCP yet. *(Shipped.)*
2. **Approvals on `/v1`, or not** — see below: approval requests carry no project, so
   this slice is a decision before it is an endpoint.
3. **Better Auth 1.6 → 1.7** — on its own, because auth is load-bearing.
4. **`mcp()` + `cimd()` + the discovery routes** — the authorization server and the
   session a tool will receive. No tools yet. **Bigger than it reads, and currently
   blocked — see below.**
5. **The MCP server with the read tools** — `transport/mcp`, `runtime/mcp.ts`, the App
   Router route, read-only by default. Proves the shape against a real client.
6. **The deciding tools** — `mocco_approvals_vote`, `mocco_gates_resume`, with the MRTR
   confirmation and the opt-in that enables them. It ships as three PRs: the per-workspace
   opt-in (`mocco_mcp_settings`, *shipped*), then `approvals:write` with the confirmation
   round trip and `mocco_approvals_vote` (*shipped* — see *How the vote is built* below),
   then `mocco_gates_resume`, which reuses the same scope, opt-in and confirmation
   (*shipped* — see *How the resume is built*). Slice 6 is complete; the next is slice 7
   or slice 8.
7. **`@mocco/cli`** — `login`, the governance commands, `ota` absorbed from
   `@mocco/cli`, which becomes an alias.
8. **OTA and flags tools** — once the shape has survived a real week. The flag reads come
   first (*shipped*): `mocco_flags_search`, `mocco_flags_get` and
   `mocco_flags_changesets_search`, read-only, over `FlagService`. Flags are
   project-scoped, so a `ProjectScope` (`domain/mcp/ProjectScope.ts`) makes the checks the
   console's `productProcedure` makes — membership, the flags product, the project in that
   workspace — and, like the workspace, the project may be left out when there is exactly
   one. Still to come: the OTA reads, a stale filter (it lives in `StaleFlagDetector`,
   a second service), and any tool that changes a flag, which needs the deciding
   machinery and its own design pass.

### How the vote is built (slice 6b)

- **Scope.** The authorization server knows `approvals:write` alongside the sign-in
  scopes. The 401 that starts a connection names only the sign-in scopes, so a client
  never asks for it up front. The tool declares it with the SDK's per-tool
  `scopeChallenge`, and a token without it gets a 403 `insufficient_scope` naming every
  scope the token has plus this one — the client re-authorizes with exactly that set, and
  the consent screen asks again because the set grew. The challenge is decided on the
  parsed `tools/call` the SDK is about to run, not on the `Mcp-Name` header; the tool
  checks the scope again itself.
- **Clients registered earlier.** A client's allowed scopes are stored when it registers,
  so one that registered before this scope existed would be refused it. Every client
  arrives through a Client ID Metadata Document, and Better Auth re-stores the client
  whenever it fetches that document again (at most an hour apart, and on a fresh process),
  so these heal by themselves.
- **Opt-in.** The tool refuses unless the workspace allows agents to decide, naming where
  an owner or admin changes it.
- **Confirmation.** The first call returns `input_required` with a form elicitation that
  states the decision, the request kind, the subject, the pinned change and the reason,
  plus a `requestState` minted by the SDK's HMAC codec. The key is derived from
  `AUTH_SECRET` (`sha256("mocco-mcp-request-state:" + secret)`, the same pattern as the
  flag stream tokens), bound to the person, the client and the method, and valid for five
  minutes. The SDK verifies it before the tool runs and refuses a forged, expired or
  foreign one with a fixed `-32602`. The tool then checks that the state is for this exact
  vote, and only an accepted `confirm: true` reaches `ApprovalService.vote`. Without
  `AUTH_SECRET` the tool refuses rather than run unconfirmed.
- **Errors.** The service's refusals (not pending, a second vote, a missing role,
  self-approval, a missing reason) come back as tool errors that say what to do next.

### How the resume is built (slice 6c)

- **Same locks, one place.** The scope check, the opt-in and the server's ability to sign
  are shared with the vote (`transport/mcp/tools/deciding.ts`), so the two deciding tools
  cannot drift apart. `confirmation.ts` needed no change: the payload already names its
  tool, so a vote's state does not parse as a resume's.
- **Scope.** It stays behind `approvals:write` — see *Decided* below.
- **Confirmation.** The first call reads the gate through `GateService.getPending`, which
  applies the same guard as `resume` (the run's current pending gate, in this workspace)
  and returns the run with its repository and commit. The person is shown the decision
  (a reject says it halts the run), the repository, the commit with its branch and subject
  line, the gate's name and index, what it requires, and the reason. The state records the
  workspace, run, gate index, decision and reason, and the retry must match all of them.
  A gate that is not current is refused before anything is asked.
- **The call.** Only an accepted `confirm: true` reaches `GateService.resume`, with the
  caller's own id, once. The answer says whether the vote was recorded and where the run
  and gate now stand — a single vote need not settle an N-of-M gate.
- **Errors.** Not the current gate, the run's triggerer under `prevent_self`, a missing
  role, a missing reason, and a second vote come back as tool errors that say what to do
  next. A gate settled between the question and the answer is refused as not current.
- **Finding the gate.** `mocco_runs_get` now puts the gate's `itemIndex` in `waitingOn`,
  so a concise read is enough to name the gate to resume.

## Evaluating it

Anthropic's guidance is that tool quality is measured, not asserted: build tasks from
real uses ("the staging deploy is stuck, find out why and approve it if the migration is
additive"), and track tool calls per task, tokens consumed, and tool errors. A tool that
is correct but costs a model forty calls to use is not finished. This belongs with
slice 5, where there is something to measure.

## Found while building slice 1: approvals have no project

A key authenticates a **project**. Runs reach one through their commit's repository and
`mocco_project_repos` — the schema even carries an index for that lookup — so `/v1/runs`
scopes cleanly.

**Approval requests do not.** `mocco_approval_requests` is workspace-scoped with an opaque
`(subject_type, subject_id)`, and the schema says so deliberately: *"Opaque to
governance."* There is no generic way to ask which project an approval belongs to without
governance learning what every product's subjects are, which is the coupling that comment
exists to prevent.

Two ways out, and the choice is worth making on its own rather than inside an endpoint:

1. **Give approval requests a `project_id`.** Honest — an approval is always *about*
   something in a project — and it would let the console filter by project too. It touches
   every requester and is a migration.
2. **Leave `/v1` without approvals.** The caller who wants them is a person in a
   workspace, which is exactly what MCP authenticates. `/v1` keeps the project-scoped
   reads a key can be trusted with, and approvals arrive with the surface that has the
   right unit of scope.

Option 2 is the smaller claim and loses nothing we have asked for, so the plan assumes it
until something needs otherwise. Either way the deciding tools are unaffected: those were
always a person's.

## Found while attempting slice 4

Two things the plan did not account for. Neither changes the design; both change what
slice 4 costs.

### The authorization server brings eight tables

`mcp()` is `@better-auth/oauth-provider` underneath, and it owns its own models: `jwks`,
`oauthClient` (31 columns), `oauthResource`, `oauthClientResource`, `oauthRefreshToken`,
`oauthAccessToken`, `oauthConsent` and `oauthClientAssertion`. We map the drizzle adapter's
schema explicitly, so every one has to exist in `schema.ts` with a migration; a missing
model fails at adapter start with *"model X was not found in the schema object"*.

**Generate them, never transcribe them.** The authoritative source is
`npx auth@<version> generate --adapter drizzle --dialect postgresql` — note the CLI moved
from `@better-auth/cli`, now deprecated at 1.5, to the `auth` package. Reading the
minified plugin source by hand missed `oauthRefreshToken` entirely and mangled the join
table's references, and these are the tables that hold tokens and consent records.

### The plugin does not typecheck against better-auth 1.7.7

`@better-auth/oauth-provider`'s plugin is not assignable to `better-auth`'s
`BetterAuthPlugin`: the `init()` return types disagree. The cause is that `better-auth`
ships its own nested `@better-auth/core` while the plugin is built against the hoisted
one, so the two see different definitions of the same type. It is a
[known upstream shape](https://github.com/better-auth/better-auth/issues/8855), and the
documented remedy — move `better-auth` and every `@better-auth/*` together on one pinned
version — does not flatten the nested copies under yarn's node-modules linker here.

Until that resolves, slice 4 cannot land. The schema work is done and saved on
`feat/mcp-auth-server`.

### What slice 4 left out, found by connecting a client

Slice 4 registered the authorization server, and slice 5 served tools behind it, but a
client could not get through: discovery 404'd because the auth handler, which answers the
root `.well-known` paths, is mounted under `/api/auth` and never saw them; the sign-in page
dropped the signed authorization request, so signing in only started a session; and the
consent page that `mcp()` redirects to did not exist. The fix routes
`/.well-known/oauth-protected-resource/*` and `/.well-known/oauth-authorization-server/*`
to the auth handler, adds the vendor's `oauthProviderClient` so sign-in, sign-up and
consent carry the signed request, and adds `/auth/consent`. An e2e test
(`packages/e2e/tests/mcp-sign-in.spec.ts`) now walks the whole path a real client takes.

### A related duplicate, now fixed

The same class of problem was already in the tree with zod: we pinned `4.1.13` while
better-auth asked for a range that did not include it, so a second copy lived nested.
That one is resolved (one zod, deduped), and it is worth keeping in mind as a pattern —
a duplicated transitive dependency shows up first as a type that "cannot be named", long
before it shows up as behaviour.

## Open questions

- **Which workspace is an agent acting in?** A person can belong to several. A call with
  no workspace is ambiguous and asking every time is noise. Likely a selection held per
  session, defaulting when there is only one.
- **Rate limits for a person's token.** `/v1` limits per key; an MCP token needs its own
  bucket, and an agent polling `mocco_runs_get` in a loop is the expected shape, not the
  abusive one.

### Decided

- **`mocco_gates_resume` stays behind `approvals:write`** (slice 6c). The question was
  whether resuming deserves its own scope because a role may be allowed to vote and not to
  resume. That distinction is already drawn, and drawn better, by the roles: a gate names
  the roles that may resume it and an approval request names the roles that may vote, and
  the service checks them on every call. The scope answers a different question — may this
  app decide anything as me at all — and to a person on a consent screen "approve or reject
  changes as you" covers both. A second scope would add a second consent prompt that
  protects nothing the roles do not, and would force the console's consent wording and the
  authorization server's client capabilities to change in the same PR. Splitting later is
  not a breaking change: a new `gates:write` would be declared by the tool's
  `scopeChallenge`, and a token that lacks it is challenged for it (403
  `insufficient_scope`) and the client steps up by itself, exactly as it did for
  `approvals:write`.
