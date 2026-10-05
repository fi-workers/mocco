---
title: Messenger
description: How Mocco's messenger stores conversations between a project's signed-in users and its team — identity signed by the app's server, sessions, seq-numbered messages, internal notes, read positions — and the /v1 and inbox surfaces over them.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-05
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
---

# Messenger

The first slice of the [messenger design](../specs/2026-09-24-messenger-design.md) (#95): an app's signed-in users write to its team, the team answers from an inbox. The first client surface is in-app "contact us" (a conversation started with a category and a first message). The tables are the messenger's, so live chat later reuses them.

## Scope and identity

- **One inbox per project.** A project's apps (iOS, Android, web) share it, and the same app user id on every platform is one contact. The design sketched app-scoped inboxes; a project is the product a user knows, so its users are one population.
- **Signed users only.** The product's server signs its user id with the project's **identity secret**: `userHash = hex(HMAC-SHA256(secret, userId))` (`signIdentity` in `@mocco/node`). Mocco compares in constant time. A client without its server's signature can't claim an id, so a publishable key alone opens nothing. Anonymous visitors come later.
- **The identity secret** is minted when the team sets the messenger up (`messenger.enable`) and on `messenger.rotateSecret`, returned only then, and stored SecretBox-sealed (AAD `messenger-identity:<projectId>`). Rotation takes effect at once: hashes signed with the old secret stop opening sessions. Both are audited (`messenger.enabled`, `messenger.secret.rotated`).
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
| `mocco_messenger_conversations` | Status (open, closed), category, `last_message_seq`, `last_operator_seq` (the team's newest public message), `contact_last_read_seq`, preview, the device context when it opened |
| `mocco_messenger_messages` | `seq` (unique per conversation), author (contact, operator, system), visibility (public, internal), body (≤ 8,000 characters), `client_message_id` (unique per conversation) |
| `mocco_messenger_operator_reads` | Each team member's read position per conversation |

- **Numbering.** A message's seq comes from `UPDATE … SET last_message_seq = last_message_seq + 1 RETURNING` in the same transaction as the insert; the row lock serializes concurrent sends and the unique index is the backstop.
- **Idempotency.** A retried send with the same `clientMessageId` returns the stored message; a retried start returns the conversation it already started.
- **Unread.** The contact has unread when `last_operator_seq > contact_last_read_seq`; a team member has unread when `last_message_seq > last_read_seq`. Writing moves the writer's own read position.
- **Internal notes** are operator-only (a CHECK) and never leave the inbox: `/v1` reads filter to public messages.
- **Reopening.** A contact writing in a closed conversation reopens it.
- **Blocking** (`messenger.setContactBlocked`, audited) stops a contact writing and opening sessions; they can still read what they have.
- **Erasing** (privacy requests) is a hard delete of the contact with every session, conversation, message, attachment, read position and push token (the foreign keys cascade), and the attachments' bytes first (`StorageService.delete`), so an erase that stops halfway can run again. The team erases from the inbox (`messenger.eraseContact`); a user erases themselves with `DELETE /v1/messenger/me`. Both are audited as `messenger.contact.erased` with only `{ projectId, by: 'operator' | 'contact' }`.

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

A contact can attach up to 3 files to a message or to the start of a conversation: screenshots (PNG, JPEG, WebP or GIF) or PDFs, up to 10 MB each (the `messenger` storage policy; 10 reservations an hour per contact). Anything else, SVG included, is refused when it's reserved.

1. `POST /v1/messenger/attachments` `{ contentType, sizeBytes, filename? }` reserves a private object (`StorageService.beginUpload`, product `messenger`) and a `mocco_messenger_attachments` row owned by the contact, and answers `201 { attachmentId, upload: { url, method: 'PUT', headers } }`.
2. The client PUTs the bytes straight to the store.
3. The message (or start) names it in `attachmentIds`. The service checks each is the contact's own and unclaimed, has storage verify the upload (`completeUpload` with the messenger's owner: exact size and declared type, or the object is deleted and the send refused with 400), then reads the bytes and checks their signature is the declared type (`sniffContentType`). A PDF declared as a PNG, or HTML declared as either, deletes the bytes and the attachment row and answers 400. It claims them in the message's transaction; if a concurrent send claimed one first, the message rolls back with 400. A retried send returns the stored message before any of this.

An attachment belongs to its contact until a message claims it, and then to that message's conversation only. Another contact's attachment, or one already in a message, is a 400 in any conversation, and another contact's conversation is a 404.

Messages carry `attachments: [{ id, contentType, sizeBytes, filename, url }]`. `filename` is the safe name the object was stored under (`Invoice March.pdf` becomes `invoice-march.pdf`). `url` is a signed link valid for 10 minutes: an image's can be shown inline, but a PDF's answers `Content-Disposition: attachment`, so it downloads and never renders on Mocco's or the bucket's origin (see [storage downloads](./storage.md#downloads)). The inbox shows images as thumbnails and PDFs as a file chip with the name and size. Without object storage configured, reserving an attachment answers 400. An upload reserved but never sent is collected by `storage.gc` after 24 hours, and sending it after that answers 400. Deleting the object deletes the attachment row.

Only contacts attach files for now. The team's replies are text.

## Push

A contact's device registers its Expo push token with `POST /v1/messenger/push-tokens` `{ provider: 'expo', token: 'ExponentPushToken[…]', platform }` (and removes it with `DELETE`, which the SDK does on sign out). Tokens are unique per project: a device that signs in as someone else moves to them (`mocco_messenger_push_tokens`, migration 0039).

A team **reply** (never an internal note) enqueues `messenger.push.reply` `{ conversationId, seq }` in the reply's transaction and kicks it after the commit. The job skips a reply the contact has already read, then sends one notification per active device through the `PushSender` port: `ExpoPushSender` posts to `https://exp.host/--/api/v2/push/send` with `fetch`, 100 per request, with `EXPO_ACCESS_TOKEN` when set ([env](./env.md#messenger-vars)). The title is the project's name, the body the start of the reply, and `data` is `{ mocco: 'messenger', conversationId }` (`messengerConversationIdOf` in the SDK reads it). A ticket with `DeviceNotRegistered` disables that token; a refused request fails the job, which the runner retries.

## SDK

`MessengerClient` in `@mocco/sdk-core` and the hooks in `@mocco/react-native/messenger` ([SDK packages](./sdk.md)) wrap these routes. The client asks the app for the signed identity (`identity()`, null while signed out), keeps the session in the app's storage under `mocco-messenger:session:v1` and reopens it on a 401, fetches threads incrementally by seq, and retries a send once on a network failure with the same `clientMessageId`. `transport/ext/v1/messenger.test.ts` runs it against the real routes.

## Inbox (tRPC)

The `messenger` router uses `productProcedure(Products.messenger)`: `settings`, `enable`, `rotateSecret`, `setCategories`, `inbox` (by status, keyset-paged by `before`, with each conversation's contact and the caller's unread state), `conversation` (every message, notes included, and the contact), `write` (reply, or `internal: true` for a note), `setStatus`, `markRead`, `setContactBlocked`, `eraseContact`.

## Console

The project's **Inbox** tab (`/workspaces/:id/p/:projectId/inbox`, `?status=closed`) sets the messenger up, lists conversations and holds the settings; a conversation is `…/inbox/:conversationId`. Both poll every 15 s. Opening a conversation marks it read for the viewer, again whenever a new message arrives. The user panel shows the contact's latest context (`last_context`) beside the context the conversation opened with.

## Events

`messenger.conversation.created` and `messenger.message.received` (a contact writing again) carry a rendered message: who wrote, the start of the text, category, app version and platform, and a link to the conversation. Both are in the Mocco notification preset.
