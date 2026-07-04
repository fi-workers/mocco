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

The product term is **workspace**, everywhere users and the DB can see: tables are `mocco_workspaces` / `mocco_members`, columns are `workspace_id` / `active_workspace_id`. The vendor's model vocabulary ("organization") survives only as drizzle object keys inside `db/schema.ts` and the adapter mapping in `auth/provider.ts` — the two files that are allowed to know the vendor. Public APIs and future UI say workspace.

## Tables & invariants (enforced at the DB)

| Invariant | Mechanism |
|---|---|
| One membership per (workspace, user) | `UNIQUE (workspace_id, user_id)` |
| Slug unique **case-insensitively** | `UNIQUE INDEX on lower(slug)` (vendor pre-check is exact-match only) |
| Roles limited to `owner · admin · member` | CHECK constraint (widen via migration when dynamic roles land) |
| Deleting a workspace removes memberships | FK `ON DELETE CASCADE` |
| Deleting a workspace clears sessions pointing at it | `sessions.active_workspace_id` FK `ON DELETE SET NULL` |

## Behavior contracts (locked by pglite tests)

- Creating a workspace makes the creator an **owner** member and sets it as the session-active workspace.
- A user can belong to multiple workspaces; `setActive` switches the session pointer.
- **Sign-up creates no workspace.** The zero-workspace state is real: onboarding UI must offer "create your first workspace". (No auto-provisioned personal workspace in MVP — deliberate, to avoid noise workspaces; revisit if onboarding friction demands it.)
- Creation policy (MVP): any authenticated user may create workspaces, no limit. Explicitly self-serve; revisit before commercial hosting.

## Deferred (by design)

- **Invitations** — land together with the invite flow (requires email delivery wiring, plus: partial unique on pending (workspace,email), status enum, responded-at timestamp, email index, and a deliberate inviter-deletion policy — naive `inviter_id ON DELETE CASCADE` would silently destroy pending invites when the inviter leaves).
- **Frontend client plugin** — the client wrapper does not yet register the organization client, so the client-side session type lacks `activeOrganizationId` while the server session has it. This skew is known and must be closed atomically with the first workspace UI (add the client plugin + neutral helpers in `lib/auth-client.ts` in that same PR).
- Teams, dynamic roles, workspace-level settings.

## Known gaps (accepted for this slice, revisit with workspace UI)

- **Last-owner protection**: ownership lives only in `members.role='owner'`; deleting the last owner (user cascade) leaves an ownerless workspace row. Role transitions (`updateMemberRole`) and sole-owner guards are untested until the member-management UI lands.
- `expiresAt`-style timestamps are `timestamp` without timezone — fine while everything runs UTC; revisit if that assumption changes.

## Boundary enforcement

`no-restricted-imports` (backend eslint) forbids importing `auth/provider` outside `auth/` — workspace capability is consumed through the neutral surface only. When a real consumer arrives, extend `auth/index.ts` with neutral functions (`createWorkspace`, `getActiveWorkspace`, …) rather than importing the provider.
