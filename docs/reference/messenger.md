---
title: Messenger
description: How Mocco's messenger stores conversations between a project's signed-in users and its team — identity signed by the app's server, sessions, seq-numbered messages, internal notes, read positions — and the /v1 and inbox surfaces over them.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-06
confidence: high
owner: andrea
tags: [reference, messenger, support]
related:
  - ../specs/2026-09-24-messenger-design.md
  - ./public-api.md
  - ./project.md
  - ../customer/messenger/contact-us.md
code_refs:
  - packages/common/src/messenger.ts
  - packages/backend/src/domain/messenger/ContactMessengerService.ts
  - packages/backend/src/domain/messenger/InboxService.ts
  - packages/backend/src/domain/messenger/MessengerSettingsService.ts
  - packages/backend/src/domain/messenger/identity.ts
  - packages/backend/src/domain/messenger/repos/conversation.repo.ts
  - packages/backend/src/transport/ext/v1/messenger.ts
  - packages/sdk-core/src/messenger.ts
  - packages/backend/src/domain/messenger/attachments.ts
  - packages/sdk-react-native/src/messenger.tsx
  - packages/backend/src/transport/trpc/routers/messenger.ts
  - packages/frontend/src/components/messenger/inbox.tsx
  - packages/frontend/src/components/messenger/conversation.tsx
  - packages/backend/src/domain/messenger/repos/inbox-member.repo.ts
  - packages/frontend/src/components/messenger/rotation.tsx
  - packages/frontend/src/components/messenger/desktop-alerts.tsx
  - packages/backend/src/domain/messenger/messages.ts
---

# Messenger

The first slice of the [messenger design](../specs/2026-09-24-messenger-design.md) (#95): an app's signed-in users write to its team, the team answers from an inbox. The first client surface is in-app "contact us" (a conversation started with a category and a first message). The tables are the messenger's, so live chat later reuses them.

## Scope and identity

- **One inbox per project.** A project's apps (iOS, Android, web) share it, and the same app user id on every platform is one contact. The design sketched app-scoped inboxes; a project is the product a user knows, so its users are one population.
- **Signed users only.** The product's server signs its user id with the project's **identity secret**: `userHash = hex(HMAC-SHA256(secret, userId))` (`signIdentity` in `@mocco/node`). Mocco compares in constant time. A client without its server's signature can't claim an id, so a publishable key alone opens nothing. Anonymous visitors come later.
- **The identity secret** is minted when the team sets the messenger up (`messenger.enable`) and on `messenger.rotateSecret`, returned only then, and stored SecretBox-sealed (AAD `messenger-identity:<projectId>`). Rotation takes effect at once: hashes signed with the old secret stop opening sessions. Both are audited (`messenger.enabled`, `messenger.secret.rotated`). The same secret signs the end-user tokens the [feedback `/v1` surface](./feedback.md#the-public-v1-surface) takes, so rotating it also stops those.
- **Sessions** are opaque `mms_` tokens (32 random bytes) stored as SHA-256 hashes, valid 30 days. The app opens a new one whenever it has a fresh hash.

## Guests

With **Let people who aren't signed in write** on (`messenger.setAllowGuests`, off by default, audited as `messenger.guests.changed`), `POST /v1/messenger/sessions` also takes `{ guest: true, email, name?, guestToken?, context? }`: someone not signed in, known by the email they leave. The first guest session returns a `guestToken` (`mmg_` + 32 random bytes, stored hashed on the contact); the device keeps it and sends it back, so a returning guest is found again (their email and name are refreshed) and sees their conversations. A contact is either signed in (`external_user_id`) or a guest (email and guest token), a CHECK enforces it.

When a signed-in session request carries the device's `guestToken`, the guest's conversations, attachments and push devices move to the signed-in contact in one transaction and the guest is deleted (with its sessions). Merging happens only through that token, never by matching emails.

Guest sessions need no signature, so they are also limited to 20 an hour per client IP. With guests off, a guest session answers `403 guests_not_allowed`.

## Model

| Table | Holds |
|---|---|
| `mocco_messenger_settings` | Per project: the sealed identity secret, the categories users pick from (default: bug, billing, how-to, idea, other) |
| `mocco_messenger_contacts` | A user who has written: the app's user id (unique per project; null for a guest), name, email and traits as the app last sent them, a guest's device token hash, the last device context, `blocked_at` |
| `mocco_messenger_sessions` | A contact's session token hash, expiry, revocation |
| `mocco_messenger_conversations` | Status (open, closed), category, `assignee_user_id` (null while unassigned), `last_message_seq`, `last_operator_seq` (the team's newest public message), `contact_last_read_seq`, preview, the device context when it opened |
| `mocco_messenger_messages` | `seq` (unique per conversation), author (contact, operator, system), visibility (public, internal), body (≤ 8,000 characters), `client_message_id` (unique per conversation) |
| `mocco_messenger_operator_reads` | Each team member's read position per conversation |
| `mocco_messenger_inbox_members` | Who takes new conversations in a project (PK project, user): `available`, `last_turn`, `last_assigned_at` |

- **Numbering.** A message's seq comes from `UPDATE … SET last_message_seq = last_message_seq + 1 RETURNING` in the same transaction as the insert; the row lock serializes concurrent sends and the unique index is the backstop.
- **Idempotency.** A retried send with the same `clientMessageId` returns the stored message; a retried start returns the conversation it already started.
- **Unread.** The contact has unread when `last_operator_seq > contact_last_read_seq`; a team member has unread when `last_message_seq > last_read_seq`. Writing moves the writer's own read position.
- **Internal notes** are operator-only (a CHECK) and never leave the inbox: `/v1` reads filter to public messages.
- **Reopening.** A contact writing in a closed conversation reopens it.
- **Blocking** (`messenger.setContactBlocked`, audited) stops a contact writing and opening sessions; they can still read what they have.
- **Erasing** (privacy requests) is a hard delete of the contact with every session, conversation, message, attachment, read position and push token (the foreign keys cascade), and the attachments' bytes first (`StorageService.delete`), so an erase that stops halfway can run again. The team erases from the inbox (`messenger.eraseContact`); a user erases themselves with `DELETE /v1/messenger/me`. Both are audited as `messenger.contact.erased` with only `{ projectId, by: 'operator' | 'contact' }`.

## Round robin

Each new conversation is assigned to one team member when it starts (#204, migration 0073). A project's **inbox members** are the workspace members in its rotation; each is available or away.

- **Who gets it.** In the conversation-start transaction, `MessengerInboxMemberRepo.takeTurn` takes `pg_advisory_xact_lock(AdvisoryLockNamespaces.messengerAssign, hashtext(projectId))`, picks the available member with the lowest `last_turn` (ties by when they joined, then user id), and sets their `last_turn` to the project's highest plus one. The conversation is created with that `assignee_user_id`. Turn numbers, not timestamps, order the rotation, so two conversations started in the same millisecond still take two turns.
- **Concurrency.** The lock holds until the start commits, so concurrent starts in one project take turns one after another and no turn is taken twice; other projects don't wait. The pglite suite (`assignment.test.ts`) covers order, skipping, and nine concurrent starts. pglite runs one transaction at a time, so the same check was also run against Postgres 16 with a 12-connection pool: 60 concurrent starts came out in strict rotation by transaction order, and without the lock the check fails.
- **Skipped.** Away members, and anyone who has left the workspace (their row stays but is ignored and not listed). With no one available, the conversation stays unassigned (`assignee_user_id` null).
- **Joining.** A member who joins or comes back from away has an old turn, so the next conversation is theirs. Removing someone from the rotation leaves the conversations they already have with them. Deleting the user unassigns their conversations (`ON DELETE SET NULL`).
- **Audit.** Adding and removing members are audited (`messenger.inbox_member.added`, `.removed`, payload `{ userId }`). Availability isn't: people switch it often, and it changes no access.

Round robin assigns only when a conversation starts. A contact writing again, or reopening a closed conversation, keeps its assignee.

**By hand.** `InboxService.assign` (#462) gives a conversation to any member of the workspace, or to no one (`assigneeUserId: null`), from the console's conversation header or `mocco_messenger_assign`. Someone outside the workspace is `NotWorkspaceMemberError` (`BAD_REQUEST`). It doesn't take a turn or touch the rotation. Giving it to whoever has it already changes nothing; any other change is audited as `messenger.conversation.assigned` (subject `messenger_conversation`, payload `{ projectId, from, to }`).

## /v1/messenger

`POST /sessions` takes a key with `messenger:chat` (a publishable key may hold it) and `{ userId, userHash, name?, email?, traits?, context? }`; it answers `201 { sessionToken, expiresAt, contactId, categories }`, `401 identity_not_verified` for a wrong hash, `403 contact_blocked`, `404` while the project has no messenger. Every other route takes `Authorization: Bearer mms_…` and is scoped to that session's contact:

| Route | Does |
|---|---|
| `GET /conversations` | The contact's conversations, newest first, with `hasUnread` |
| `POST /conversations` | `{ category?, body, clientMessageId, context? }` → `201 { conversation }`; unknown category → 400 |
| `GET /conversations/{id}/messages?afterSeq=` | Public messages after a seq, oldest first, with the team member's name on replies |
| `POST /conversations/{id}/messages` | `{ body, clientMessageId, context? }` → `201 { message }` |
| `POST /conversations/{id}/read` | `{ seq }` → `204`; never moves back or past the last message |
| `POST /attachments` | Reserve a screenshot or PDF upload; see [Attachments](#attachments) |
| `DELETE /me` | Erase the contact and everything they wrote → `204`; the session stops working (see Erasing above) |

Another contact's conversation is a 404. Limits per contact, on top of the key's own: 20 messages a minute, 5 new conversations an hour; `POST /sessions` 300 a minute per key.

## Attachments

A contact can attach up to 3 files to a message or to the start of a conversation, and a team member to a reply or a note ([From the team](#from-the-team)): screenshots (PNG, JPEG, WebP or GIF) or PDFs, up to 10 MB each (the `messenger` storage policy; 10 reservations an hour per contact). Anything else, SVG included, is refused when it's reserved.

1. `POST /v1/messenger/attachments` `{ contentType, sizeBytes, filename? }` reserves a private object (`StorageService.beginUpload`, product `messenger`) and a `mocco_messenger_attachments` row owned by the contact, and answers `201 { attachmentId, upload: { url, method: 'PUT', headers } }`.
2. The client PUTs the bytes straight to the store.
3. The message (or start) names it in `attachmentIds`. The service checks each is the contact's own and unclaimed, has storage verify the upload (`completeUpload` with the messenger's owner: exact size and declared type, or the object is deleted and the send refused with 400), then reads the bytes and checks their signature is the declared type (`sniffContentType`). A PDF declared as a PNG, or HTML declared as either, deletes the bytes and the attachment row and answers 400. It claims them in the message's transaction; if a concurrent send claimed one first, the message rolls back with 400. A retried send returns the stored message before any of this.

An attachment belongs to its contact until a message claims it, and then to that message's conversation only. Another contact's attachment, or one already in a message, is a 400 in any conversation, and another contact's conversation is a 404.

Messages carry `attachments: [{ id, contentType, sizeBytes, filename, url }]`. `filename` is the safe name the object was stored under (`Invoice March.pdf` becomes `invoice-march.pdf`). `url` is a signed link valid for 10 minutes: an image's can be shown inline, but a PDF's answers `Content-Disposition: attachment`, so it downloads and never renders on Mocco's or the bucket's origin (see [storage downloads](./storage.md#downloads)). The inbox shows images as thumbnails and PDFs as a file chip with the name and size. Without object storage configured, reserving an attachment answers 400. An upload reserved but never sent is collected by `storage.gc` after 24 hours, and sending it after that answers 400. Deleting the object deletes the attachment row.

### From the team

A team member attaches up to 3 files to a reply or an internal note from the inbox (#430), through the same functions in `attachments.ts` as a contact: the same types and 10 MB limit (the `messenger` storage policy), the same byte checks on send, the same claim and the same links.

1. `messenger.createAttachment` `{ workspaceId, projectId, conversationId, contentType, sizeBytes, filename? }` reserves the upload for the conversation's contact. The conversation is looked up within the workspace and project, so another project's or workspace's is `NOT_FOUND`. The object records the team member as `created_by_user_id`. There's no hourly cap: the caller is a signed-in member.
2. The console PUTs the bytes straight to the store.
3. `messenger.write` names them in `attachmentIds`. Each must be unclaimed, reserved for this conversation's contact, and uploaded by the caller; the bytes are verified as above and the attachments claimed in the reply's transaction.

The uploader is what keeps the two sides apart: a contact can only send uploads with no `created_by_user_id`, and a team member only their own. So a contact can't send what the team reserved, one team member can't send another's, and an upload reserved in one project's conversation can't go into another project's (a different contact) or be reached through another workspace. The contact's app receives a reply's attachments like any other, through `GET /v1/messenger/conversations/{id}/messages`. A note's attachments stay in the inbox, because `/v1` only serves public messages. Erasing the contact erases the team's files in their conversations too.

No migration: the attachment row keeps the contact it was reserved for, and the uploader is on the storage object. The MCP tools send text only (see [MCP tools](#mcp-tools)), so attaching from an agent is still to come.

## Push

A contact's device registers its Expo push token with `POST /v1/messenger/push-tokens` `{ provider: 'expo', token: 'ExponentPushToken[…]', platform }` (and removes it with `DELETE`, which the SDK does on sign out). Tokens are unique per project: a device that signs in as someone else moves to them (`mocco_messenger_push_tokens`, migration 0039).

A team **reply** (never an internal note) enqueues `messenger.push.reply` `{ conversationId, seq }` in the reply's transaction and kicks it after the commit. The job skips a reply the contact has already read, then sends one notification per active device through the `PushSender` port: `ExpoPushSender` posts to `https://exp.host/--/api/v2/push/send` with `fetch`, 100 per request, with `EXPO_ACCESS_TOKEN` when set ([env](./env.md#messenger-vars)). The title is the project's name, the body the start of the reply, and `data` is `{ mocco: 'messenger', conversationId }` (`messengerConversationIdOf` in the SDK reads it). A ticket with `DeviceNotRegistered` disables that token; a refused request fails the job, which the runner retries.

## SDK

`MessengerClient` in `@mocco/sdk-core` and the hooks in `@mocco/react-native/messenger` ([SDK packages](./sdk.md)) wrap these routes. The client asks the app for the signed identity (`identity()`, null while signed out), keeps the session in the app's storage under `mocco-messenger:session:v1` and reopens it on a 401, fetches threads incrementally by seq, and retries a send once on a network failure with the same `clientMessageId`. `transport/ext/v1/messenger.test.ts` runs it against the real routes.

## Inbox (tRPC)

The `messenger` router uses `productProcedure(Products.messenger)`: `settings`, `enable`, `rotateSecret`, `setCategories`, `inbox` (by status, keyset-paged by `before`, with each conversation's contact and the caller's unread state), `conversation` (every message, notes included, and the contact), `createAttachment` (reserve an image or PDF upload in a conversation), `write` (reply, or `internal: true` for a note, with up to 3 `attachmentIds`), `setStatus`, `markRead`, `assign({ conversationId, assigneeUserId | null })` (by hand, audited; see [round robin](#round-robin)), `setContactBlocked`, `eraseContact`, and the rotation: `inboxMembers` (each member's name, email, availability and last assignment), `addInboxMember` (workspace members only, else `BAD_REQUEST`), `removeInboxMember`, `setAvailability({ userId, available })` (an id not in the rotation is `NOT_FOUND`). `inbox` rows and `conversation` carry `assignee: { userId, name } | null`.

## Console

The project's **Inbox** tab (`/workspaces/:id/p/:projectId/inbox`, `?status=closed`) sets the messenger up, lists conversations with each one's assignee and holds the settings; a conversation is `…/inbox/:conversationId`, and its header's **Assigned to** picker shows who has it and hands it to any workspace member or to no one. A bar over the list is the viewer's own rotation switch: **Join the rotation**, then **Available** or away. The settings' **Round robin** section lists the members with their availability and last assignment, adds workspace members and removes them. Both poll every 15 s. The composer's **Attach** picks up to 3 images or PDFs (checked for type and size before uploading, then again by the server), uploads them when the reply is sent, and shows the server's refusal if one fails the byte check. Opening a conversation marks it read for the viewer, again whenever a new message arrives. The user panel shows the contact's latest context (`last_context`) beside the context the conversation opened with.

## MCP tools

Agents reach the inbox through four tools in `transport/mcp/tools/messenger.ts` (#462, ADR 0025), thin adapters over `InboxService` behind `ProjectScope` with `Products.messenger`, so a conversation of another project or workspace reads exactly like one that does not exist. Customer setup is in [Connect Mocco to your agent](../customer/mcp/connect.md).

| Tool | Service call | Notes |
|---|---|---|
| `mocco_messenger_conversations_search` | `list` | `status` `open` (default), `closed` or `all`; `assignee` `me`, a user id or `unassigned`; `contact` matches a contact's id, email (any case) or `external_user_id` exactly; `limit` up to 50, keyset-paged by `before` (`nextBefore`, a `last_message_at`); concise or detailed |
| `mocco_messenger_conversation_get` | `get` | The latest `limit` messages (default 50) oldest first, notes marked, with `earlierMessages`; each attachment as id, file name, type and size. The signed download link `get` makes for the console is dropped. Detailed adds the contact's email, user id, traits and last context, and each message's context |
| `mocco_messenger_reply` | `write` (`internal: false`) | Text only. The confirmation shows the contact and the exact text; the signed state records the conversation's `last_message_seq` when asked, so once the reply is sent (or the contact writes again) the same confirmation no longer matches. The message's `client_message_id` is `mcp:` plus a hash of the person, conversation, that seq and the text, so two concurrent answers to one confirmation still write one message |
| `mocco_messenger_assign` | `assign` | `assignee` `me`, a user id or `unassigned`. The confirmation shows who has it and who takes it, and the state records both, so a reassignment in between asks again. Someone outside the workspace is refused before asking, and an assignment that changes nothing answers without asking |

Reply and assign are behind the same locks as every changing tool: the `messenger:write` OAuth scope (stepped up for per tool), the workspace's `agents_may_decide` opt-in and a server able to sign the confirmation (`openDecision`, `confirmThenApply`). Both act as the caller, and any workspace member may use them, as in the inbox. Notes, attachments, closing, blocking, erasing and the rotation stay in the console.

## Events

`messenger.conversation.created` and `messenger.message.received` (a contact writing again) carry a rendered message: who wrote, the start of the text, category, app version and platform, and a link to the conversation. Both are in the Mocco notification preset. The created event also has an **Assigned to** field: the member round robin chose, or `Unassigned`.

`messenger.conversation.unassigned` ("No one is available for …", same fields) is published alongside the created event when round robin found no available member. It isn't in the Mocco preset, since it repeats a created event; a channel for the conversations nobody took (a support lead's Slack or Discord channel) adds a rule for it alone.

These go through the ordinary notification fan-out to the workspace's channels (see [Notifications](./notifications.md)); the messenger has no sender of its own. **Once per conversation event:** both start events carry a dedupe key (`<type>:<conversationId>`), so a retried start (same `clientMessageId`), which announces again in case the first attempt stopped before it did, returns the stored event and creates nothing; the fan-out's `UNIQUE (event_id, channel_id)` and the delivery job's dedupe make a redelivered event a no-op too. `domain/messenger/notifications.test.ts` drives a start, its retry and a redelivery through the real bus and fan-out to a fake Discord sender and counts one send.

## Browser notifications

While the **Inbox** tab is open on the Open list, each conversation its 15 s poll finds that wasn't in the list it first loaded raises a system notification through the browser's Notification API (`New conversation from …`, the preview as the body, tagged with the conversation id so the browser shows one per conversation; clicking it opens the conversation). The bar over the list asks for permission (**Turn on desktop notifications**) and then says they are on, or that the browser blocks them. Nothing is sent while the tab is closed; Slack or Discord rules cover that. No service worker or push subscription is involved.
