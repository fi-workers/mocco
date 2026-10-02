---
title: Messenger
description: How Mocco's messenger stores conversations between a project's signed-in users and its team — identity signed by the app's server, sessions, seq-numbered messages, internal notes, read positions — and the /v1 and inbox surfaces over them.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [reference, messenger, support]
related:
  - ../specs/2026-09-24-messenger-design.md
  - ./public-api.md
  - ./project.md
code_refs:
  - packages/common/src/messenger.ts
  - packages/backend/src/domain/messenger/ContactMessengerService.ts
  - packages/backend/src/domain/messenger/InboxService.ts
  - packages/backend/src/domain/messenger/MessengerSettingsService.ts
  - packages/backend/src/domain/messenger/identity.ts
  - packages/backend/src/domain/messenger/repos/conversation.repo.ts
  - packages/backend/src/transport/ext/v1/messenger.ts
  - packages/backend/src/transport/trpc/routers/messenger.ts
---

# Messenger

The first slice of the [messenger design](../specs/2026-09-24-messenger-design.md) (#95): an app's signed-in users write to its team, the team answers from an inbox. The first client surface is in-app "contact us" (a conversation started with a category and a first message). The tables are the messenger's, so live chat later reuses them.

## Scope and identity

- **One inbox per project.** A project's apps (iOS, Android, web) share it, and the same app user id on every platform is one contact. The design sketched app-scoped inboxes; a project is the product a user knows, so its users are one population.
- **Signed users only.** The product's server signs its user id with the project's **identity secret**: `userHash = hex(HMAC-SHA256(secret, userId))` (`signIdentity` in `@mocco/node`). Mocco compares in constant time. A client without its server's signature can't claim an id, so a publishable key alone opens nothing. Anonymous visitors come later.
- **The identity secret** is minted when the team sets the messenger up (`messenger.enable`) and on `messenger.rotateSecret`, returned only then, and stored SecretBox-sealed (AAD `messenger-identity:<projectId>`). Rotation takes effect at once: hashes signed with the old secret stop opening sessions. Both are audited (`messenger.enabled`, `messenger.secret.rotated`).
- **Sessions** are opaque `mms_` tokens (32 random bytes) stored as SHA-256 hashes, valid 30 days. The app opens a new one whenever it has a fresh hash.

## Model

| Table | Holds |
|---|---|
| `mocco_messenger_settings` | Per project: the sealed identity secret, the categories users pick from (default: bug, billing, how-to, idea, other) |
| `mocco_messenger_contacts` | A user who has written: the app's user id (unique per project), name, email and traits as the app last sent them, the last device context, `blocked_at` |
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

## /v1/messenger

`POST /sessions` takes a key with `messenger:chat` (a publishable key may hold it) and `{ userId, userHash, name?, email?, traits?, context? }`; it answers `201 { sessionToken, expiresAt, contactId, categories }`, `401 identity_not_verified` for a wrong hash, `403 contact_blocked`, `404` while the project has no messenger. Every other route takes `Authorization: Bearer mms_…` and is scoped to that session's contact:

| Route | Does |
|---|---|
| `GET /conversations` | The contact's conversations, newest first, with `hasUnread` |
| `POST /conversations` | `{ category?, body, clientMessageId, context? }` → `201 { conversation }`; unknown category → 400 |
| `GET /conversations/{id}/messages?afterSeq=` | Public messages after a seq, oldest first, with the team member's name on replies |
| `POST /conversations/{id}/messages` | `{ body, clientMessageId, context? }` → `201 { message }` |
| `POST /conversations/{id}/read` | `{ seq }` → `204`; never moves back or past the last message |

Another contact's conversation is a 404. Limits per contact, on top of the key's own: 20 messages a minute, 5 new conversations an hour; `POST /sessions` 300 a minute per key.

## Inbox (tRPC)

The `messenger` router uses `productProcedure(Products.messenger)`: `settings`, `enable`, `rotateSecret`, `setCategories`, `inbox` (by status, keyset-paged by `before`, with each conversation's contact and the caller's unread state), `conversation` (every message, notes included, and the contact), `write` (reply, or `internal: true` for a note), `setStatus`, `markRead`, `setContactBlocked`.

## Events

`messenger.conversation.created` and `messenger.message.received` (a contact writing again) carry a rendered message: who wrote, the start of the text, category, app version and platform, and a link to the conversation. Both are in the Mocco notification preset.
