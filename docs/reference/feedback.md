---
title: Feedback board model
description: How Mocco stores a project's feedback boards — boards, categories, posts with a per-board number, and each post's append-only status history — the statuses and how staff move a post between them, how the staff list sorts, what is audited, the feedback tRPC router, and the feedback MCP tools.
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
  - packages/backend/src/domain/feedback/errors.ts
  - packages/backend/src/transport/trpc/routers/feedback.ts
  - packages/backend/src/transport/mcp/tools/feedback.ts
---

# Feedback board model

The first slice (#172) of the [feedback design](../specs/2026-09-24-feedback-design.md) (#98): staff create a project's boards and categories, write posts, and move posts through statuses over tRPC, and agents read boards and posts and move posts over MCP (#468). Votes, comments, merging, GitHub links, shipping on deploy, the changelog and the public `/v1` surface come in later slices. There is no console screen yet.

## Tables

Migration 0076 adds four tables. Every row carries `workspace_id`. Children reach their board through a composite FK on `(board_id, workspace_id, project_id)`, so a row can never point at another tenant's board.

| Table | What it holds |
|---|---|
| `mocco_feedback_boards` | A board of a project: `slug` (unique within the project, same pattern as a project handle), `name`, `is_public` (default true; the public surface reads it later), and `next_post_number` |
| `mocco_feedback_categories` | A board's categories: `slug` (unique within the board), `name`, `position` |
| `mocco_feedback_posts` | A post: `number` (unique within the board), `title`, `body` (Markdown), `status`, `category_id` (a category of the same board, or null), `shipped_at`, and `author_user_id` (the staff member who wrote it; end-user authors come with end-user identity) |
| `mocco_feedback_status_changes` | Append-only history: `from_status` (null on the row written when the post is created), `to_status`, `reason`, `actor_user_id` |

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

## Audit

`feedback.board.created`, `feedback.board.deleted`, and `feedback.post.status_changed` (with `from`, `to`, the board and the post number) are appended after their transaction commits. Category and post edits aren't audited.

## The feedback router

`feedback.*` procedures all use `productProcedure(Products.feedback)`: the caller must be a member of the workspace (NOT_FOUND otherwise), the project must belong to it (NOT_FOUND), and the feedback product must be enabled (FORBIDDEN). The same chain maps the domain's errors: `FeedbackBoardNotFoundError`, `FeedbackCategoryNotFoundError` and `FeedbackPostNotFoundError` are NOT_FOUND; `FeedbackSlugTakenError`, `FeedbackStatusUnchangedError` and `FeedbackStatusMovedError` are CONFLICT. Entities are looked up within the caller's workspace and project, so another tenant's id is NOT_FOUND. A test calls every procedure as a non-member and with another tenant's ids.

| Procedure | Does |
|---|---|
| `boards`, `board` | List the project's boards; one board with its categories in order |
| `createBoard`, `updateBoard`, `deleteBoard` | Deleting a board deletes its categories, posts and history |
| `createCategory`, `updateCategory`, `deleteCategory` | Deleting a category leaves its posts on the board, uncategorized |
| `posts`, `post` | The list above; one post with its status history, oldest first |
| `createPost`, `updatePost` | An update changes only the fields it is given; `categoryId: null` uncategorizes |
| `setPostStatus` | The status change above; returns the post and the history row |

## MCP tools

Per [ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md), four tools sit over these services (`transport/mcp/tools/feedback.ts`, #468). Each goes through `ProjectScope` with `Products.feedback` and the caller's own id first: the caller must be a member of the workspace, feedback must be enabled there, and the project must belong to it. The services then look boards and posts up only inside that project, so another tenant's board or post reads exactly like one that does not exist.

| Tool | Over | Answers or does |
|---|---|---|
| `mocco_feedback_boards_list` | `BoardService.listBoards`, `getBoard` | The project's boards (id, slug, name, public) with their categories' ids and names in order; detailed adds category slugs and positions and the boards' timestamps |
| `mocco_feedback_posts_search` | `PostService.list` | One board's posts, filtered by status and category, sorted by status (workflow order) or newest, `limit` up to 99 and `offset`, with `nextOffset` when there is more; concise is id, number, title, status, category id and when it was posted, detailed adds the first 500 characters of the body, `shippedAt`, `updatedAt` and the author's user id |
| `mocco_feedback_post_get` | `PostService.get` | One post and its history, oldest first (from, to, reason, when); concise cuts the body at 500 characters (`isBodyCut`), detailed has it whole with the author and each change's actor (user ids) |
| `mocco_feedback_post_set_status` | `PostService.setStatus` | Moves the post to another status as the caller |

`mocco_feedback_post_set_status` has the locks of every changing MCP tool: the `feedback:write` scope (a token without it is challenged for it), the workspace's **Settings → Agents** opt-in, and a confirmation round trip that names the post, its status now and the status it would get. The signed confirmation records that `from` status, so a post moved by anyone before the answer is refused as a different change, and the tool passes `from` to `setStatus` so the service re-checks it under the post's lock. A second answer to the same confirmation finds the post moved already and writes nothing; asking for the status a post already has answers without asking. The change is the console's: a history row with reason `manual` and a `feedback.post.status_changed` audit entry naming the caller.

Voting, merging and accepting a ship suggestion get their tools in the slices that build them.
