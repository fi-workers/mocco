---
title: Feedback board model
description: How Mocco stores a project's feedback boards — boards, categories, posts with a per-board number, each post's append-only status history, end users' votes, comments and subscriptions, and merged duplicates — the statuses and how staff move a post between them, how votes are counted, who sees which comments, how merging moves votes and subscribers, how the staff list sorts, what is audited, the feedback tRPC router, the feedback MCP tools, and the public /v1 surface with end-user tokens, and the public board pages.
type: reference
status: active
created: 2026-10-06
updated: 2026-10-17
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
  - packages/backend/src/transport/ext/sites/feedback.ts
  - packages/backend/src/transport/sites/feedback.ts
  - packages/frontend/src/pages/_sites/[site]/feedback/[board]/index.tsx
  - packages/frontend/src/pages/_sites/[site]/feedback/[board]/[number].tsx
  - packages/frontend/src/lib/feedback-client.ts
  - packages/sdk-core/src/feedback.ts
  - packages/sdk-core/src/whats-new.ts
  - packages/sdk-core/src/feedback-sheet.ts
---

# Feedback board model

The first slices of the [feedback design](../specs/2026-09-24-feedback-design.md) (#98): staff create a project's boards and categories, write posts, and move posts through statuses over tRPC (#172), and agents read boards and posts and move posts over MCP (#468); end users' votes, comments and subscriptions, the team's official responses and internal notes, and merging duplicates (#173); the public `/v1` surface (#174, [below](#the-public-v1-surface)): reads, the similar-posts search, and posts, votes, comments and follows from the app's signed-in end users, voting by email, and signed unsubscribe links; the public board and post pages (#175, [below](#public-board-pages)). GitHub links, shipping on deploy and the changelog come in later slices. There is no console screen yet.

## Tables

Migration 0076 adds four tables. Every row carries `workspace_id`. Children reach their board through a composite FK on `(board_id, workspace_id, project_id)`, so a row can never point at another tenant's board.

| Table | What it holds |
|---|---|
| `mocco_feedback_boards` | A board of a project: `slug` (unique within the project, same pattern as a project handle), `name`, `is_public` (default true; the public surface reads it later), and `next_post_number` |
| `mocco_feedback_categories` | A board's categories: `slug` (unique within the board), `name`, `position` |
| `mocco_feedback_posts` | A post: `number` (unique within the board), `title`, `body` (Markdown), `status`, `category_id` (a category of the same board, or null), `shipped_at`, and its author: `author_user_id` (a staff member) or `author_end_user_id` (an end user, from `/v1`; migration 0080), never both (DB-checked) |
| `mocco_feedback_status_changes` | Append-only history: `from_status` (null on the row written when the post is created), `to_status`, `reason`, `actor_user_id` |

Migration 0077 (#173) adds two more tables and two counters on posts, `vote_count` and `comment_count` (see [Votes](#votes) and [Comments](#comments)). Both tables reach their post through a composite FK on `(post_id, workspace_id)`.

| Table | What it holds |
|---|---|
| `mocco_feedback_votes` | A vote: `end_user_id`, `state` (`pending` or `counted`), `source` (`web`, `widget`, `staff`, `intake`, `merge`), `recorded_by_user_id` (the team member who recorded it for the end user), `counted_at` (set exactly when counted, DB-checked). Unique on `(post_id, end_user_id)` |
| `mocco_feedback_comments` | A comment: `author_kind` (`staff` or `end_user`), `author_user_id` or `author_end_user_id`, `body` (up to 8,000 characters), `is_official`, `is_internal` |

Migration 0078 (#173) adds `mocco_feedback_subscriptions` (`end_user_id`, `unsubscribed_at`; unique on `(post_id, end_user_id)`, the same composite FK) and two columns on posts: `merged_into_post_id` (an FK on `(merged_into_post_id, workspace_id)`, so a post can only be merged into one of its own workspace) and `merged_at`. A check holds both set or both null, and a post never merged into itself (see [Merging duplicates](#merging-duplicates)).

Migration 0080 (#174) adds `author_end_user_id` to posts (see the table above) and a partial index on votes `(workspace_id, end_user_id) WHERE state = 'pending'`, which an email voter's confirmation reads ([voting by email](#voting-by-email)).

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

`feedback.board.created`, `feedback.board.deleted`, `feedback.post.status_changed` (with `from`, `to`, the board and the post number) and `feedback.post.merged` (on the source, with the board, both post numbers, `intoPostId` and `votesAdded`) are appended after their transaction commits. Category and post edits aren't audited. The changelog's audit actions are under [Changelog](#changelog).

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

## Changelog

A board's changelog (#176): entries the team writes in Markdown, each announcing posts that shipped. Built so far: the model, the service, the `changelog` router and the publish job, the public changelog and `/v1` (below). The console comes next.

**Tables.** `mocco_changelog_entries` (board-scoped through the boards' composite FK, so an entry can't point at another tenant's board; deleting the board deletes its entries): `slug` (unique per board, `CHANGELOG_SLUG_PATTERN`, 1–80 characters), `title`, `body_md`, `tags` (a `text[]` of `new`, `improved`, `fixed`, DB-checked; the design's separate tags table wasn't needed), `state` (`draft`, `scheduled`, `published`), `publish_at` (set exactly while scheduled) and `published_at` (set exactly while published), both held by one CHECK, and `created_by_user_id` (SET NULL). `mocco_changelog_entry_posts` links an entry to the posts it announces, in order (`position`); deleting either side removes the link. The widget's read cursors and the run that drafted an entry (#179) come with their slices.

**ChangelogService** (`domain/feedback/ChangelogService.ts`, `ctx.feedbackChangelog`):

- `create` makes a draft. Without a slug, one comes from the title (`Dark mode is here!` → `dark-mode-is-here`, or the date when nothing ASCII is left), with `-2`, `-3`… added while the board has it; an explicit taken slug is `FeedbackSlugTakenError` (CONFLICT). Posts must be live posts of the entry's board (not another board's, not a merged duplicate), else `ChangelogPostsInvalidError` (BAD_REQUEST); duplicates collapse in order.
- `update` edits in any state; `postIds` and `tags` replace the lists.
- `publish` (draft or scheduled → published now), `schedule` (draft or scheduled → scheduled at a time ahead, else `ChangelogPublishAtPastError`, BAD_REQUEST), `unpublish` (published or scheduled → draft) and `delete`. A move the state doesn't allow is `ChangelogEntryStateError` (CONFLICT). Each locks the entry row first.
- `list` is a board's entries, newest published, scheduled or edited first, optionally in one state.

**Publish job.** `feedback.changelog.publish_due` runs every minute: it takes up to 100 scheduled entries whose `publish_at` has passed (`FOR UPDATE SKIP LOCKED`, so two runs never publish one twice) and publishes each as of its scheduled time.

**Audit.** `feedback.changelog.published` (by the team member, or with no actor from the job), `feedback.changelog.unpublished` (only from published) and `feedback.changelog.deleted`, each with the board, slug and title. Edits and scheduling aren't audited.

**Router.** `changelog.entries`, `entry`, `create`, `update`, `publish`, `schedule` (`publishAt`), `unpublish` and `delete`, behind `productProcedure(Products.feedback)` like the feedback router. A test calls every procedure as a non-member and with another tenant's ids (NOT_FOUND).

**Public changelog.** A public board's published entries are on its help site, beside its board and roadmap:

- `/feedback/<board>/changelog` lists them newest first (`PublicBoardService.changelog`, 50 a page), each with its date, tags, text and the posts it shipped. `/feedback/<board>/changelog/<slug>` is one entry (`changelogEntry`). Both are ISR like the other board pages, and a draft, scheduled or missing entry is a 404. The header gets a **Changelog** link, and every board page has an RSS `<link rel="alternate">`.
- A post's page lists the published entries that shipped it as **Shipped in** (`changelogForPost`, the newest 10).
- Entries go through `feedbackV1ChangelogEntrySchema` (id, slug, title, body, tags, `publishedAt`, and the posts' id, number, title and status), so the author and drafts never reach a page. Ties on `published_at` order the newest-created first.
- The body is the team's Markdown, rendered like a help article (`helpArticleBlocks`): http(s), mailto and site links, https images, raw HTML as text, so a `javascript:` link or a `<script>` renders as nothing that runs.
- **RSS.** `/feedback/<board>/changelog.rss` is rewritten to `/api/seo/changelog`, which resolves the help site from the host like the sitemap (`changelogRssFor`). It's RSS 2.0 with an `atom:link rel="self"`, `lastBuildDate`, and an item per entry with a permalink `guid`, an RFC 822 `pubDate`, a `category` per tag and a plain-text `description` (`changelogPlainText`: the Markdown's words, no HTML, code blocks left out, at most 1000 characters). Every value is XML-escaped, and a test feeds it script tags, an `onerror` image, a `javascript:` link and inline HTML. Off a help site, or for a private or missing board, it is 404.
- **Sitemap.** The help site's sitemap lists `/feedback/<board>/changelog` once the board has a published entry, and each published entry (the newest 1000 per project).

**`/v1` and the "what's new" badge.** `GET /boards/{slug}/changelog` pages published entries newest first (the same projection). `GET /boards/{slug}/changelog/unread` answers `{ count, lastSeenAt }`: the entries published after the end user's stored cursor when a token comes with the request; without one (or before their first "seen"), after `?since=`, which a widget keeps on the device for visitors; else every entry. It counts up to 100 (`CHANGELOG_UNREAD_CAP`). `POST /boards/{slug}/changelog/seen` needs `feedback:write` and an end-user token and moves the cursor to now, never back (`greatest`), in `mocco_feedback_changelog_reads` (one row per board and end user, board-scoped by the composite FK, deleted with the board). It has its own limit, 120 an hour per end user, so a widget opening often doesn't use up the address's write budget. Private and missing boards are 404, as everywhere on `/v1`.

**SDKs** (#177, first slice). `FeedbackClient` (`@mocco/sdk-core/feedback`) and `WhatsNew` (`@mocco/sdk-core/whats-new`) call these routes; `@mocco/js/whats-new` mounts a badge and popover on a page and `@mocco/react-native/whats-new` has `useWhatsNew` and `<WhatsNewBadge />` ([SDK packages](./sdk.md), [customer guide](../customer/feedback/whats-new.md)). Every client sends `since`: the `publishedAt` of the newest entry the device has marked seen, so for a visitor the count never depends on the device's clock, and a user who signs in later starts from what this device saw. Signed in, marking seen also posts `changelog/seen`, and the server's cursor wins from then on.

**SDKs, second slice** (#177). `FeedbackClient` also calls `similar`, `posts` (create), `roadmap`, comments (list and create) and `subscription` (follow and unfollow). `FeedbackSheetModel` (`@mocco/sdk-core/feedback-sheet`) is the state behind the feedback sheets: `@mocco/js/feedback-sheet` (a side sheet mounted on a page's button) and `<FeedbackSheet />` in `@mocco/react-native/feedback` ([customer guide](../customer/feedback/in-app-ideas.md)). The sheet searches `similar` once typing pauses (300 ms, from 3 characters), so it stays under the address's 60-a-minute limit. A signed-in sheet reads its list with the end user's token, so each post's `viewerVote` shows their earlier votes as **Voted** when the sheet opens (the similar posts carry it too). The client sends the token on `posts`, `roadmap` and `similar`; a token source that throws reads those as a visitor.

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
- In a list read with an end-user token (a board's posts, the roadmap, the similar posts), each post carries `viewerVote`: that end user's own vote on it, `counted`, `pending` or null. Without a token the field is absent. It is never another end user's vote.
- Comments are the public ones only (internal notes never), each with its author's kind, `isOfficial` and `isMine` (the viewer's own). No team member's id and no other end user's id: an app's user ids can be emails.
- A post an end user wrote never says who: `author_end_user_id` stays with the team.
- GitHub links aren't built yet. When they are, the projection carries only number and state, never their title.

A test reads every route after an internal note, an official response, another end user's comment and a token carrying an email, and checks that none of those ids, the note or the email is in any answer.

**Reads.** `GET /boards/{slug}` (name and categories), `GET /boards/{slug}/posts` (filter by status and category slug, `sort` `top`, most counted votes first, or `new`; `limit` up to 100, `offset`, `nextOffset`), `GET /boards/{slug}/roadmap` (the 50 most voted posts of each of planned, in progress and shipped), `GET /posts/{id}` (with `viewer: { vote }`, `counted`, `pending` or null, when a token comes with it) and `GET /posts/{id}/comments` (oldest first, paged the same way). With a token, the posts list, the roadmap and `similar` add `viewerVote` to each post, read in one query over the answer's post ids (`FeedbackVoteRepo.statesFor`), not one per post. A token can't claim an email voter's id (`email:…`), so `viewerVote` never shows an email vote. The public board pages never send a token with their cached HTML or their list reads, so no one's vote is baked into a page.

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

## Public board pages

A project's public boards have pages on its help center's site (#175, [ADR 0015](../adr/0015-public-sites-use-isr-on-the-pages-router.md)): `/feedback/<board>` lists a board, `/feedback/<board>/roadmap` shows its roadmap and `/feedback/<board>/<number>` shows one post, so `showyourtime.help.mocco.club/feedback/ideas/12`, or the site's custom domain. The help site is the project's one public host so far; the site's slug names the project the way a key does on `/v1`. A project without a help site has no board pages. Customer guide: [Open a public feedback board](../customer/feedback/public-board.md).

**Rendering.** `pages/_sites/[site]/feedback/[board]/index.tsx`, `roadmap.tsx` and `[number].tsx` are ISR (`getStaticProps`, `fallback: 'blocking'`, 60 seconds), so a crawler or a browser without JavaScript reads the board and its posts. Their data comes from `@mocco/backend/sites/feedback` (`transport/sites/feedback.ts`), which reads through `PublicBoardService` and parses every post, comment and board through the same `@mocco/common/feedback-v1` schemas `/v1` answers with. A private or missing board, an unknown number and an unknown site are 404. A merged duplicate's number redirects permanently (308) to the post it was merged into (`PublicBoardService.postOnBoard`, a post by its number on the board). A post's Markdown becomes the render tree on the server, with links and images shown as their text, so the board is no place to plant links. Comments are plain text.

**SEO.** Each page has its canonical and Open Graph URLs on the site's origin (`helpSiteOrigin`), a signed share card (ADR 0030), a `BreadcrumbList`, and on a post a `DiscussionForumPosting` with its vote and comment counts. Pages carry `referrer: no-referrer`. Without `HELP_SITES_DOMAIN` (no origin to be canonical on) a page is `noindex`.

**The browser's calls.** Filters (`?status=&category=&sort=`, in the address), the next page, the live count, the viewer's own vote, posting, voting, comments, similar posts and voting by email go to `/api/ext/sites/{site}/feedback/*` (`transport/ext/sites/feedback.ts`). These are the `/v1/feedback` routes themselves, mounted behind the site instead of a key (`createFeedbackRoutes` takes a gate): the site's project is the principal, as a publishable key with `feedback:read` and `feedback:write` would be, after a per-address limit (120 a minute). So the projection, the end-user token checks and the per-end-user and per-address [limits](#the-public-v1-surface) are the same code. Answers are `no-store`. It is not a versioned API: apps and widgets use `/v1` with their key.

**Signing in.** An app links its signed-in user to the board with `?token=<the HS256 end-user token>`. The page keeps the token in `sessionStorage` for that tab, takes it out of the address through the router, and sends it as `Authorization: Bearer`. A refused or expired token is forgotten, and the page falls back to voting by email. Without a token a visitor reads and votes by email; posting and commenting need a token.

A test (`transport/ext/sites/feedback.test.ts`) builds both pages' data and calls the routes after an internal note, an official response, another end user's comment and a post written by an email-like end-user id, and checks that none of the note, the team member's id, the end users' ids, the email or the workspace, project and board ids is in any page or answer.

**Roadmap.** `/feedback/<board>/roadmap` shows the planned, in progress and shipped columns side by side, the 50 most voted posts of each (`PublicBoardService.roadmap`, the same columns `GET /boards/{slug}/roadmap` answers), merged duplicates left out. The category filter (`?category=<slug>`) is in the address and narrows the columns already on the page in the browser, so a filtered roadmap can be shared as a link; without JavaScript, and for crawlers, every category shows, and the canonical URL has no filter.

**Sitemap.** The help site's `/sitemap.xml` also lists each public board, its roadmap and its live posts (merged duplicates left out), with their last change as `lastmod`, at most 10,000 posts per project, the most recently changed first (`PublicBoardService.sitemap`). Board pages are served in one language, so they carry no `hreflang` alternates.

Not built yet: the console's inbox.
