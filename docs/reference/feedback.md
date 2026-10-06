---
title: Feedback board model
description: How Mocco stores a project's feedback boards — boards, categories, posts with a per-board number, each post's append-only status history, end users' votes, comments and subscriptions, and merged duplicates — the statuses and how staff move a post between them, how votes are counted, who sees which comments, how merging moves votes and subscribers, how the staff list sorts, what is audited, the feedback tRPC router, the feedback MCP tools, and the public /v1 surface with end-user tokens.
type: reference
status: active
created: 2026-10-06
updated: 2026-10-06
confidence: high
owner: andrea
tags: [reference, feedback, boards, posts]
related:
  - ../specs/2026-09-24-feedback-design.md
  - ./project.md
code_refs:
  - packages/common/src/feedback.ts
  - packages/backend/src/domain/feedback/BoardService.ts
  - packages/backend/src/domain/feedback/PostService.ts
  - packages/backend/src/domain/feedback/VoteService.ts
  - packages/backend/src/domain/feedback/CommentService.ts
  - packages/backend/src/domain/feedback/SubscriptionService.ts
  - packages/backend/src/domain/feedback/MergeService.ts
  - packages/backend/src/domain/feedback/errors.ts
  - packages/backend/src/transport/trpc/routers/feedback.ts
  - packages/backend/src/transport/mcp/tools/feedback.ts
  - packages/backend/src/transport/mcp/tools/feedback-engagement.ts
  - packages/backend/src/domain/feedback/PublicBoardService.ts
  - packages/backend/src/domain/enduser/EndUserTokenService.ts
  - packages/backend/src/transport/ext/v1/feedback.ts
  - packages/common/src/feedback-v1.ts
  - packages/backend/src/domain/feedback/EmailVoteService.ts
  - packages/backend/src/domain/feedback/link-tokens.ts
  - packages/backend/src/transport/ext/v1/feedback-links.ts
---

# Feedback board model

The first slices of the [feedback design](../specs/2026-09-24-feedback-design.md) (#98): staff create a project's boards and categories, write posts, and move posts through statuses over tRPC (#172), and agents read boards and posts and move posts over MCP (#468); end users' votes, comments and subscriptions, the team's official responses and internal notes, and merging duplicates (#173); the public `/v1` surface (#174, [below](#the-public-v1-surface)): reads, the similar-posts search, and posts, votes, comments and follows from the app's signed-in end users, voting by email, and signed unsubscribe links. GitHub links, shipping on deploy and the changelog come in later slices. There is no console screen yet.

## Tables

Migration 0076 adds four tables. Every row carries `workspace_id`. Children reach their board through a composite FK on `(board_id, workspace_id, project_id)`, so a row can never point at another tenant's board.

| Table | What it holds |
|---|---|
| `mocco_feedback_boards` | A board of a project: `slug` (unique within the project, same pattern as a project handle), `name`, `is_public` (default true; the public surface reads it later), and `next_post_number` |
| `mocco_feedback_categories` | A board's categories: `slug` (unique within the board), `name`, `position` |
| `mocco_feedback_posts` | A post: `number` (unique within the board), `title`, `body` (Markdown), `status`, `category_id` (a category of the same board, or null), `shipped_at`, and its author: `author_user_id` (a staff member) or `author_end_user_id` (an end user, from `/v1`; migration 0079), never both (DB-checked) |
| `mocco_feedback_status_changes` | Append-only history: `from_status` (null on the row written when the post is created), `to_status`, `reason`, `actor_user_id` |

Migration 0077 (#173) adds two more tables and two counters on posts, `vote_count` and `comment_count` (see [Votes](#votes) and [Comments](#comments)). Both tables reach their post through a composite FK on `(post_id, workspace_id)`.

| Table | What it holds |
|---|---|
| `mocco_feedback_votes` | A vote: `end_user_id`, `state` (`pending` or `counted`), `source` (`web`, `widget`, `staff`, `intake`, `merge`), `recorded_by_user_id` (the team member who recorded it for the end user), `counted_at` (set exactly when counted, DB-checked). Unique on `(post_id, end_user_id)` |
| `mocco_feedback_comments` | A comment: `author_kind` (`staff` or `end_user`), `author_user_id` or `author_end_user_id`, `body` (up to 8,000 characters), `is_official`, `is_internal` |

Migration 0078 (#173) adds `mocco_feedback_subscriptions` (`end_user_id`, `unsubscribed_at`; unique on `(post_id, end_user_id)`, the same composite FK) and two columns on posts: `merged_into_post_id` (an FK on `(merged_into_post_id, workspace_id)`, so a post can only be merged into one of its own workspace) and `merged_at`. A check holds both set or both null, and a post never merged into itself (see [Merging duplicates](#merging-duplicates)).

Migration 0079 (#174) adds `author_end_user_id` to posts (see the table above) and a partial index on votes `(workspace_id, end_user_id) WHERE state = 'pending'`, which an email voter's confirmation reads ([voting by email](#voting-by-email)).

An end user is the id the project's app knows them by: the user id it signs, the same id space as a messenger contact's `external_user_id`. End-user identity (#100) isn't built yet. When it gives these ids a directory, votes, comments and subscriptions point into it; until then the column carries the id itself (1 to 255 characters).

The design keys board slugs per workspace; they are per project here, so two projects of one workspace can both have an `ideas` board. The public surface resolves a board through the project's publishable key, so the slug never needs to be unique across projects.

A post's number comes from its board's `next_post_number`, taken by an `UPDATE … RETURNING` in the post's transaction. The update locks the board row, so concurrent posts get distinct numbers, and a failed insert gives its number back.

## Statuses

`FeedbackPostStatuses` in `@mocco/common/feedback` is the only source of the values: `under_review`, `planned`, `in_progress`, `shipped`, `closed`. The DB checks are generated from the same object. `RoadmapColumns` (planned, in progress, shipped) names the public roadmap's columns.

- A post is created `under_review` unless staff pick another status.
- Staff may move a post from any status to any other (`PostService.setStatus`). Setting the status it already has is `FeedbackStatusUnchangedError` (CONFLICT), and nothing is written.
- Every status a post takes is a `mocco_feedback_status_changes` row, written in the same transaction as the post: `created` for the first, `manual` for a staff change. `FeedbackStatusChangeReasons` also lists `ship_suggestion`, `auto_apply` and `merge`, which later slices write.
- Entering `shipped` sets `shipped_at`; leaving it clears it. A DB check holds `shipped_at` set exactly when the status is `shipped`.
- The status change locks the post row, so two concurrent changes apply one after the other and each records the status it left.
- `setStatus` takes an optional `from`: the change applies only while the post is still in that status, checked under the same lock, else `FeedbackStatusMovedError` (CONFLICT) and nothing is written. The MCP tool passes the status its confirmation showed; the console does not pass it.

## Listing

`PostService.list` reads one board, filtered by status or category, with `limit` (1 to 100, default 50) and `offset`:

- `sort: status` (the default): workflow order (`FEEDBACK_POST_STATUS_ORDER`: under review, planned, in progress, shipped, closed), newest first within a status.
- `sort: newest`: newest first.

Another project's board is `FeedbackBoardNotFoundError`, never an empty list.

## Votes

`VoteService` holds one vote per post and end user, enforced by the unique index:

- **Voting is idempotent.** A second vote by the same end user returns the first and changes nothing. Two concurrent votes insert once: the post row is locked first, and the insert is `ON CONFLICT DO NOTHING`.
- **Pending, then counted.** An identified end user's vote counts at once. An email-only voter's vote is written `pending` and counts when they confirm (`confirm`), or when they vote again identified. Confirming a counted vote changes nothing; confirming a vote that isn't there is `FeedbackVoteNotFoundError` (NOT_FOUND).
- **Taking a vote back** deletes it; no vote is no change.
- **`vote_count` equals the post's counted votes.** It moves by one in the transaction that counts or removes a counted vote, after that transaction has locked the post row, so concurrent writes to one post apply one after another. A test runs a long random sequence of votes, pending votes, confirmations and removals, six at a time, and checks the count against the rows after every batch.

Votes aren't audited: there are many, and they are the end users' own. The team records a vote on an end user's behalf (`source: staff`); the app's signed-in end users vote through [the public `/v1` surface](#the-public-v1-surface) (`source: web` or `widget`), counted at once. An email-only voter's vote waits as pending until they open the link mailed to them ([voting by email](#voting-by-email)).

## Subscriptions

`SubscriptionService` keeps who follows a post, to be told when it moves (the notification fan-out comes with the ship detector):

- **Voting subscribes.** `VoteService.vote` inserts a subscription in the vote's transaction unless the end user has a row already.
- **Opting out sticks.** `unsubscribe` sets `unsubscribed_at` and keeps the row, so voting again later doesn't resubscribe; `subscribe` clears it. Both are idempotent.
- `list` returns a post's current subscribers, oldest first.

## Comments

`CommentService` writes two kinds of comment:

- **A team member's** (`createAsStaff`): plain, the **official response** (`isOfficial`), or an **internal note** (`isInternal`). A comment can't be both: the service refuses it (`FeedbackOfficialInternalError`, BAD_REQUEST) and a DB check holds it.
- **An end user's** (`createAsEndUser`): always public and never official, DB-checked.

Reads come in two projections. `listForStaff` returns every comment, oldest first, internal notes included. `listForPublic` leaves internal notes out and returns only the id, the author kind, the end user's id on their own comments, the body, `isOfficial` and when, so no team member's id reaches the public board. `comment_count` counts public comments only, so the public count never gives away that a note exists.

## Merging duplicates

`MergeService.merge(source, target)` folds a duplicate into the post it repeats, both on one board:

- **Votes move without double counting.** The source's votes are copied to the target as `merge` votes with `INSERT … ON CONFLICT (post_id, end_user_id)`: an end user who voted on both keeps one vote, counted if either of theirs was. The target's `vote_count` is then recounted from its rows.
- **Subscribers move** the same way. A row the end user already has on the target wins, and opt-outs copy as opt-outs.
- **No chains.** Posts merged into the source earlier now point at the target, so `merged_into_post_id` is always a post that isn't merged itself.
- **The history stays.** The source keeps its own votes, comments, subscriptions and status history. It is closed, with a status-change row of reason `merge` (none when it was closed already), and `merged_into_post_id` and `merged_at` are set.
- **Refusals.** Merging a merged post, or into one, is `FeedbackPostMergedError` (CONFLICT; it carries `intoPostId`). A post into itself, or into a post on another board, is `FeedbackMergeInvalidError` (BAD_REQUEST). Another project's post is NOT_FOUND.
- **A merged post takes no more votes or subscriptions** (`FeedbackPostMergedError` with `intoPostId`, so the public surface can send the end user to the target). Comments and staff status changes still work.

**Concurrency.** One transaction takes the `feedbackPost` advisory lock (`AdvisoryLockNamespaces.feedbackPost`) for both posts, then both rows `FOR UPDATE`, each in id order, so two merges sharing a post apply one after another and never deadlock. Votes and subscriptions lock their post row first (`lockLivePost`), so none can land on a post while its votes are being moved. Tests run four merges into one target at once (each voter counted once) and two crossing merges with votes arriving together (one merge wins, the other is refused, and the live post's count equals its counted votes).

## Audit

`feedback.board.created`, `feedback.board.deleted`, `feedback.post.status_changed` (with `from`, `to`, the board and the post number) and `feedback.post.merged` (on the source, with the board, both post numbers, `intoPostId` and `votesAdded`) are appended after their transaction commits. Category and post edits aren't audited.

## The feedback router

`feedback.*` procedures all use `productProcedure(Products.feedback)`: the caller must be a member of the workspace (NOT_FOUND otherwise), the project must belong to it (NOT_FOUND), and the feedback product must be enabled (FORBIDDEN). The same chain maps the domain's errors: `FeedbackBoardNotFoundError`, `FeedbackCategoryNotFoundError`, `FeedbackPostNotFoundError` and `FeedbackVoteNotFoundError` are NOT_FOUND; `FeedbackSlugTakenError`, `FeedbackStatusUnchangedError`, `FeedbackStatusMovedError` and `FeedbackPostMergedError` are CONFLICT; `FeedbackOfficialInternalError` and `FeedbackMergeInvalidError` are BAD_REQUEST. Entities are looked up within the caller's workspace and project, so another tenant's id is NOT_FOUND. A test calls every procedure as a non-member and with another tenant's ids.

| Procedure | Does |
|---|---|
| `boards`, `board` | List the project's boards; one board with its categories in order |
| `createBoard`, `updateBoard`, `deleteBoard` | Deleting a board deletes its categories, posts and history |
| `createCategory`, `updateCategory`, `deleteCategory` | Deleting a category leaves its posts on the board, uncategorized |
| `posts`, `post` | The list above; one post with its status history, oldest first |
| `createPost`, `updatePost` | An update changes only the fields it is given; `categoryId: null` uncategorizes |
| `setPostStatus` | The status change above; returns the post and the history row |
| `votes`, `vote`, `unvote` | A post's votes, newest first, pending ones included; record an end user's vote on their behalf (it counts at once); take one back |
| `comments`, `createComment` | A post's comments for the team, internal notes included; comment as the caller, plainly, as the official response or as an internal note |
| `subscribers` | A post's current subscribers, oldest first |
| `mergePost` | Merge the post into `intoPostId` as the caller (above); returns the closed source and the recounted target |

## MCP tools

Per [ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md), four tools sit over these services (`transport/mcp/tools/feedback.ts`, #468). Each goes through `ProjectScope` with `Products.feedback` and the caller's own id first: the caller must be a member of the workspace, feedback must be enabled there, and the project must belong to it. The services then look boards and posts up only inside that project, so another tenant's board or post reads exactly like one that does not exist.

| Tool | Over | Answers or does |
|---|---|---|
| `mocco_feedback_boards_list` | `BoardService.listBoards`, `getBoard` | The project's boards (id, slug, name, public) with their categories' ids and names in order; detailed adds category slugs and positions and the boards' timestamps |
| `mocco_feedback_posts_search` | `PostService.list` | One board's posts, filtered by status and category, sorted by status (workflow order) or newest, `limit` up to 99 and `offset`, with `nextOffset` when there is more; concise is id, number, title, status, category id and when it was posted, detailed adds the first 500 characters of the body, `shippedAt`, `updatedAt` and the author's user id |
| `mocco_feedback_post_get` | `PostService.get` | One post and its history, oldest first (from, to, reason, when); concise cuts the body at 500 characters (`isBodyCut`), detailed has it whole with the author and each change's actor (user ids) |
| `mocco_feedback_post_set_status` | `PostService.setStatus` | Moves the post to another status as the caller |

`mocco_feedback_post_set_status` has the locks of every changing MCP tool: the `feedback:write` scope (a token without it is challenged for it), the workspace's **Settings → Agents** opt-in, and a confirmation round trip that names the post, its status now and the status it would get. The signed confirmation records that `from` status, so a post moved by anyone before the answer is refused as a different change, and the tool passes `from` to `setStatus` so the service re-checks it under the post's lock. A second answer to the same confirmation finds the post moved already and writes nothing; asking for the status a post already has answers without asking. The change is the console's: a history row with reason `manual` and a `feedback.post.status_changed` audit entry naming the caller.

Five more (`transport/mcp/tools/feedback-engagement.ts`, #473) sit over `VoteService`, `CommentService` and `MergeService` behind the same `ProjectScope` check:

| Tool | Over | Answers or does |
|---|---|---|
| `mocco_feedback_votes_list` | `VoteService.list` | A post's votes, newest first: end user, `counted` or `pending`, when; detailed adds the id, source, `countedAt` and the team member who recorded it. `limit` up to 99, `offset`, `nextOffset` |
| `mocco_feedback_comments_list` | `CommentService.listForStaff` | A post's comments, oldest first, internal notes included and marked; concise cuts each body at 500 characters, detailed has it whole with the author ids. Paged the same way |
| `mocco_feedback_comment_create` | `CommentService.createAsStaff` | Comments as the caller: public, the official response, or an internal note |
| `mocco_feedback_post_vote` | `VoteService.vote` | Records an end user's vote on their behalf (`source: staff`), counted at once |
| `mocco_feedback_post_merge` | `MergeService.merge` | Merges a duplicate into another post on its board as the caller |

The three changes have the locks of `mocco_feedback_post_set_status`: `feedback:write`, the opt-in and a confirmation round trip. Each confirmation is bound to what it showed. A comment is bound to its text and kind. A vote is bound to whether the end user had a pending vote or none; one that counts already answers without asking. A merge is bound to both posts, their board and each post's vote count, so a vote on either before the answer asks again. A post merged in between, a post into itself, or a post on another board is refused before asking. The services check the same rules again under their locks ([Merging duplicates](#merging-duplicates)).

## The public /v1 surface

`/api/ext/v1/feedback` (#174, `transport/ext/v1/feedback.ts`) serves a project's public boards to its app, its widget and public board pages, over `PublicBoardService`. Routes and status codes are in the [public API reference](./public-api.md#routes).

**Keys.** Reads take a key with `feedback:read`; votes and comments a key with `feedback:write`. A publishable key may hold both. The key's project is the scope: a board is found by its slug within that project, so another project's board, post or token reads as not there.

**End-user tokens.** A vote or comment also needs to know who the end user is. The app's server signs a short-lived JWT for its signed-in user and the app sends it as `Authorization: Bearer …`, with the key in `X-Mocco-Key`:

- HS256, signed with the project's **identity secret**: the secret the messenger setup mints and shows once, the one `signIdentity` in `@mocco/node` uses for the messenger's `userHash`. No second secret: one project, one secret its server signs its users with. The secret is SecretBox-sealed at rest (it has to be opened to verify a signature, so it can't be stored as a hash).
- `sub` is the end user's id as the app knows them, the id votes and comments carry. `exp` is required and may be at most an hour ahead; 60 seconds of clock skew are allowed. Other claims (`email`, `name`) are ignored and never stored.
- Refused tokens are `401 invalid_end_user_token`: expired, signed by another project's secret (another project's token), not HS256, too long-lived, or presented to a project with no identity secret yet. A write without a token is `401 missing_end_user_token`. A bad token on a read is refused too, rather than read as nobody.
- `EndUserTokenService` (`domain/enduser/`) verifies; it reads the secret through `MessengerSettingsService.identitySecretOf`. When end-user identity (#100) lands, the secret moves to the project's identity config and the same service reads it there.

**The public projection.** `PublicBoardService` answers only from explicit projections, and the routes parse every answer through `@mocco/common/feedback-v1`, which drops any field not named there:

- A private board (`is_public` false), its posts and their comments are `404`, the same as a board that doesn't exist.
- Lists leave merged duplicates out. Reading a duplicate by id still works and carries `mergedIntoPostId`; voting on one is `409` with that id in `detail`.
- A post is its id, number, title, body, status, category id, vote and comment counts, `createdAt`, `shippedAt` and `mergedIntoPostId`: never the team member who wrote it, the workspace, or the board's internals.
- Comments are the public ones only (internal notes never), each with its author's kind, `isOfficial` and `isMine` (the viewer's own). No team member's id and no other end user's id: an app's user ids can be emails.
- A post an end user wrote never says who: `author_end_user_id` stays with the team.
- GitHub links aren't built yet. When they are, the projection carries only number and state, never their title.

A test reads every route after an internal note, an official response, another end user's comment and a token carrying an email, and checks that none of those ids, the note or the email is in any answer.

**Reads.** `GET /boards/{slug}` (name and categories), `GET /boards/{slug}/posts` (filter by status and category slug, `sort` `top`, most counted votes first, or `new`; `limit` up to 100, `offset`, `nextOffset`), `GET /boards/{slug}/roadmap` (the 50 most voted posts of each of planned, in progress and shipped), `GET /posts/{id}` (with `viewer: { vote }`, `counted`, `pending` or null, when a token comes with it) and `GET /posts/{id}/comments` (oldest first, paged the same way).

**Similar posts.** `GET /boards/{slug}/similar?q=&limit=` (`feedback:read`, up to 10, default 5) answers the posts most like a title being typed, so the end user can vote instead of posting a duplicate. It is the design's fallback without an LLM: the query's words (letters and digits, two or more characters, at most eight) are matched literally in the title and body, a title match counting twice, then by votes; merged duplicates are left out. 60 searches a minute per client address.

**Writes.** `POST /boards/{slug}/posts` (`{ title, body?, categoryId?, source? }`) posts as the end user through `PostService.createAsEndUser`: the post starts under review, with the author's counted vote and subscription, written in one transaction with its `created` history row (no actor). `POST /posts/{id}/vote` votes through `VoteService.vote`, counted at once (the app's server vouched for the user), so it is idempotent and, like any vote, subscribes the voter. `DELETE` takes it back. `POST /posts/{id}/comments` comments through `CommentService.createAsEndUser`. `POST`/`DELETE /posts/{id}/subscription` follows or stops following through `SubscriptionService` (`{ subscribed }`; an opt-out still outlives later votes). Their locks and counters are the services'.

**Limits.** On top of the key's own: 30 votes and unvotes, 20 comments, 5 posts and 30 follows or unfollows an hour per end user (the bucket is a hash of the project and the end user's id), and 120 writes an hour per client address, whoever signs in. Over a limit is `429 rate_limited` with `Retry-After`. The production driver is the Postgres limiter.

### Voting by email

Someone the app hasn't signed in can still vote, with their email address (`EmailVoteService`, `transport/ext/v1/feedback-links.ts`):

- `POST /identify/email` (`feedback:write`, no end-user token) with `{ email, postId, source? }` writes a **pending** vote for the end user `email:<address, lowercased>` and mails the address. It answers `202 { status: "pending_confirmation" }`, never the address. Signed tokens can't claim an `email:` id: a token whose `sub` starts with it is `401 invalid_end_user_token`.
- The mail goes through the notifications email sender (`EMAIL_DRIVER`; `log` prints it instead of sending, the development default). Without a sender, or without `AUTH_SECRET` to sign links, the route answers `503 email_unavailable` and writes nothing.
- The mail's link, `GET /identify/email/confirm?token=`, counts every pending vote that address cast in the project in the last 7 days (measured by the database clock that wrote them) through `VoteService.confirm`, and shows a small page. A vote on a post merged or deleted since is skipped. The link works for a day; opening it again changes nothing.
- 10 email votes per 10 minutes per client address, and 3 an hour per address mailed (per project).

An email voter can't post or comment: that needs a token from the app's server.

### Unsubscribe links

Every feedback mail carries a signed unsubscribe link, `/unsubscribe/{token}`, in its body and in `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). `EmailVoteService.unsubscribeUrlOf` makes one for any later mail, such as the status-change fan-out.

- `GET` asks first and changes nothing, so a mail scanner opening the link unsubscribes nobody. `POST` (the page's form, or the mail client's one click) unsubscribes the end user from the post; for a merged duplicate, from the post it was merged into, which took its subscribers. Both are idempotent.
- The links take no key. A token is `<claims>.<HMAC-SHA256>` over its purpose (`identify` or `unsubscribe`), workspace, project, end user, post and expiry, with a key derived from `AUTH_SECRET` (apart from the status subscribers' key), like the [status subscriber links](./status.md#subscribers). Nothing is stored. An edited token, one signed with another key, an expired one or one for the other purpose gets the "not valid" page (`400`).
- The pages are `no-store`, `noindex`, `no-referrer`, and escape the post's title. 30 link openings a minute per client address.

