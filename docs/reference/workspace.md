---
title: Workspace model
type: reference
status: active
created: 2026-07-04
updated: 2026-07-04
confidence: high
owner: andrea
tags: [reference, workspace, auth, schema]
---

# Workspace model

> A **workspace** is Mocco's team boundary: members, roles, and (later) repo integrations and billing hang off it. It is independent of GitHub — GitHub only links identity. Implemented via the auth vendor's organization plugin, mapped onto product-termed tables.

## Naming decision

The product term is **workspace**, everywhere users and the DB can see: tables are `mocco_workspaces` / `mocco_members`, columns are `workspace_id` / `active_workspace_id`. The vendor's model vocabulary ("organization") survives only inside `auth/` (the provider, and the auth tests that legitimately exercise the vendor API) plus the drizzle object keys in `db/schema.ts` that the adapter mapping requires. Everything outside that boundary — public APIs, docs, future UI — says workspace, and eslint blocks vendor imports outside `auth/`.

## Tables & invariants (enforced at the DB)

| Invariant | Mechanism |
|---|---|
| One membership per (workspace, user) | `UNIQUE (workspace_id, user_id)` |
| Slug unique **case-insensitively** | `UNIQUE INDEX on lower(slug)` — the only slug uniqueness (subsumes exact matches; vendor pre-check is exact-match only) |
| Roles limited to `owner · admin · member` (single or comma-joined subset — the vendor stores multi-role updates as `'owner,admin'`) | CHECK regex constraint (widen via migration when dynamic roles land) |
| Deleting a workspace removes memberships | FK `ON DELETE CASCADE` |
| Deleting a workspace clears sessions pointing at it | `sessions.active_workspace_id` FK `ON DELETE SET NULL` (indexed) |
| Slugs stored lowercase | normalized in the create hook; the lower(slug) index is the backstop |

## Behavior contracts (locked by pglite tests)

- Creating a workspace makes the creator an **owner** member and sets it as the session-active workspace.
- A user can belong to multiple workspaces; `setActive` switches the session pointer.
- **Sign-up creates no workspace.** The zero-workspace state is real: onboarding UI must offer "create your first workspace". (No auto-provisioned personal workspace in MVP — deliberate, to avoid noise workspaces; revisit if onboarding friction demands it.)
- Creation policy (MVP): any authenticated user may create workspaces, no limit. Explicitly self-serve; revisit before commercial hosting.

## Deferred (by design)

- **Invitations** — the TABLE exists (`mocco_invitations`, vendor shape + email index) because the plugin's core read path (`get-full-organization`) hard-joins the model; without it the primary workspace load 500s (probe-verified). The invite FLOW lands together with the invite flow (requires email delivery wiring, plus: partial unique on pending (workspace,email), status enum, responded-at timestamp, email index, and a deliberate inviter-deletion policy — naive `inviter_id ON DELETE CASCADE` would silently destroy pending invites when the inviter leaves). ⚠️ The vendor's default table name is unprefixed `invitation`: the invite-flow PR must map it to `mocco_invitations` or the `mocco_` prefix invariant silently breaks.
- **Frontend client plugin** — no longer needed: workspaces are consumed via tRPC (see Boundary enforcement), so the client session type never has to carry `activeOrganizationId`.
- Teams, dynamic roles, workspace-level settings.

## Known gaps (accepted for this slice, revisit with workspace UI)

- **`active_workspace_id` is a hint, not authorization.** The vendor clears it on self-leave only; an admin removing member B leaves B's other sessions pointing at the workspace. Any consumer MUST re-check membership — never authorize by the session pointer alone.
- The vendor's slug-availability pre-check is exact-match; a case-variant probe can report "available" and then fail at the DB index. Cosmetic (integrity holds); revisit with workspace UI validation.
- **Last-owner protection**: ownership lives only in `members.role='owner'`; deleting the last owner (user cascade) leaves an ownerless workspace row. Role transitions (`updateMemberRole`) and sole-owner guards are untested until the member-management UI lands.
- `expiresAt`-style timestamps are `timestamp` without timezone — fine while everything runs UTC; revisit if that assumption changes.

## Boundary enforcement

`no-restricted-imports` (backend eslint) forbids importing `auth/provider` and the vendor package outside `auth/` (test files excepted — they may probe vendor behavior directly). The neutral surface is one cohesive service class per domain (`auth/AuthService.ts`, `auth/WorkspaceService.ts`), constructor-injected with the provider: production constructs them once in `auth/instance.ts`, tests construct the same classes over pglite — no test-only seams. The tRPC workspace domain router (`trpc/routers/workspace.ts`, composed in `trpc/root.ts`) consumes it via context injection, and its `.output()` schemas — zod schemas in `@mocco/common/workspace`, the single type source (`z.input` = vendor-compatible internal rows, `z.output` = wire shape) — are the egress filter: raw vendor rows carry extra fields (probe-verified: `metadata`), which the output schemas strip — and they normalize `logo` to `string | null` — before anything crosses the wire. The frontend talks tRPC and never needs a vendor client plugin (which also settles the once-deferred client session-type skew).
