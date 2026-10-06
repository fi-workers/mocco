---
title: Feedback board model
description: How Mocco stores a project's feedback boards — boards, categories, posts with a per-board number, each post's append-only status history, end users' votes, comments and subscriptions, and merged duplicates — the statuses and how staff move a post between them, how votes are counted, who sees which comments, how merging moves votes and subscribers, how the staff list sorts, what is audited, the feedback tRPC router, and the feedback MCP tools with those planned next.
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
---

# Feedback board model

The first slices of the [feedback design](../specs/2026-09-24-feedback-design.md) (#98): staff create a project's boards and categories, write posts, and move posts through statuses over tRPC (#172), and agents read boards and posts and move posts over MCP (#468); end users' votes, comments and subscriptions, the team's official responses and internal notes, and merging duplicates (#173). GitHub links, shipping on deploy, the changelog and the public `/v1` surface come in later slices. There is no console screen yet.

## Tables

Migration 0076 adds four tables. Every row carries `workspace_id`. Children reach their board through a composite FK on `(board_id, workspace_id, project_id)`, so a row can never point at another tenant's board.

| Table | What it holds |
|---|---|
| `mocco_feedback_boards` | A board of a project: `slug` (unique within the project, same pattern as a project handle), `name`, `is_public` (default true; the public surface reads it later), and `next_post_number` |
| `mocco_feedback_categories` | A board's categories: `slug` (unique within the board), `name`, `position` |
| `mocco_feedback_posts` | A post: `number` (unique within the board), `title`, `body` (Markdown), `status`, `category_id` (a category of the same board, or null), `shipped_at`, and `author_user_id` (the staff member who wrote it; end-user authors come with end-user identity) |
| `mocco_feedback_status_changes` | Append-only history: `from_status` (null on the row written when the post is created), `to_status`, `reason`, `actor_user_id` |

Migration 0077 (#173) adds two more tables and two counters on posts, `vote_count` and `comment_count` (see [Votes](#votes) and [Comments](#comments)). Both tables reach their post through a composite FK on `(post_id, workspace_id)`.

| Table | What it holds |
|---|---|
| `mocco_feedback_votes` | A vote: `end_user_id`, `state` (`pending` or `counted`), `source` (`web`, `widget`, `staff`, `intake`, `merge`), `recorded_by_user_id` (the team member who recorded it for the end user), `counted_at` (set exactly when counted, DB-checked). Unique on `(post_id, end_user_id)` |
| `mocco_feedback_comments` | A comment: `author_kind` (`staff` or `end_user`), `author_user_id` or `author_end_user_id`, `body` (up to 8,000 characters), `is_official`, `is_internal` |

Migration 0078 (#173) adds `mocco_feedback_subscriptions` (`end_user_id`, `unsubscribed_at`; unique on `(post_id, end_user_id)`, the same composite FK) and two columns on posts: `merged_into_post_id` (an FK on `(merged_into_post_id, workspace_id)`, so a post can only be merged into one of its own workspace) and `merged_at`. A check holds both set or both null, and a post never merged into itself (see [Merging duplicates](#merging-duplicates)).

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

Votes aren't audited: there are many, and they are the end users' own. The public `/v1` surface will take votes from the board and the widget, with the email confirmation flow; for now the team records a vote on an end user's behalf (`source: staff`).

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

The rest of #173 gets its tools in the next slice, over `VoteService`, `CommentService` and `MergeService`:

- `mocco_feedback_votes_list`: a post's votes, paged, concise or detailed.
- `mocco_feedback_comments_list`: a post's comments as the team sees them, internal notes included, paged.
- `mocco_feedback_comment_create`: comment as the caller, plainly, as the official response or as an internal note. It changes data, so it sits behind `feedback:write`, the opt-in and the confirmation round trip.
- `mocco_feedback_post_vote`: record an end user's vote on their behalf, behind the same locks.
- `mocco_feedback_post_merge`: merge a duplicate into another post as the caller, behind the same locks, with a confirmation bound to both posts being unmerged when it was asked.
