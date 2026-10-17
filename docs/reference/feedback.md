---
title: Feedback board model
description: How Mocco stores a project's feedback boards — boards, categories, posts with a per-board number, each post's append-only status history, end users' votes, comments and subscriptions, and merged duplicates, and the GitHub issues and pull requests linked to posts, and shipping posts on release — the statuses and how staff move a post between them, how votes are counted, who sees which comments, how merging moves votes and subscribers, how the staff list sorts, what is audited, the feedback tRPC router, the feedback MCP tools, and the public /v1 surface with end-user tokens, and the public board pages.
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
  - ./github-app.md
  - ./releases.md
  - ../adr/0031-feedback-ships-on-the-release-registry-not-environments.md
code_refs:
  - packages/common/src/feedback.ts
  - packages/backend/src/domain/feedback/BoardService.ts
  - packages/backend/src/domain/feedback/PostService.ts
  - packages/backend/src/domain/feedback/VoteService.ts
  - packages/backend/src/domain/feedback/CommentService.ts
  - packages/backend/src/domain/feedback/SubscriptionService.ts
  - packages/backend/src/domain/feedback/MergeService.ts
  - packages/backend/src/domain/feedback/errors.ts
  - packages/backend/src/domain/feedback/LinkService.ts
  - packages/backend/src/domain/feedback/ShipDetector.ts
  - packages/backend/src/domain/feedback/ShipSuggestionService.ts
  - packages/backend/src/domain/feedback/ancestry-checks.ts
  - packages/backend/src/domain/feedback/subscribers.ts
  - packages/frontend/src/components/feedback-console/ship-suggestions.tsx
  - packages/frontend/src/components/feedback-console/github-links.tsx
  - packages/backend/src/transport/trpc/routers/feedback.ts
  - packages/backend/src/transport/mcp/tools/feedback.ts
  - packages/backend/src/transport/mcp/tools/feedback-shipping.ts
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
---

# Feedback board model

The first slices of the [feedback design](../specs/2026-09-24-feedback-design.md) (#98): staff create a project's boards and categories, write posts, and move posts through statuses over tRPC (#172), and agents read boards and posts and move posts over MCP (#468); end users' votes, comments and subscriptions, the team's official responses and internal notes, and merging duplicates (#173); the public `/v1` surface (#174, [below](#the-public-v1-surface)): reads, the similar-posts search, and posts, votes, comments and follows from the app's signed-in end users, voting by email, and signed unsubscribe links; the public board and post pages (#175, [below](#public-board-pages)). GitHub links (#178, [below](#github-links)) let staff tie a post to the issues and pull requests that deliver it, and a release that contains them suggests marking the post shipped (#179, [below](#shipping-on-release)).

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
- `sort: top`: most counted votes first, newest first among equals (the console inbox's "Most voted").

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

## Suggested duplicates

Staff get pairs of posts that may be the same request (#181). Migration 0084 adds `mocco_feedback_duplicate_candidates` and `duplicates_checked_at` on posts; migration 0086 adds `mocco_feedback_post_embeddings` and the `embedding` method.

- **The sweep.** The `feedback.duplicates.detect` job runs every minute (`DuplicateService.detectDue`). It takes up to 50 posts with no `duplicates_checked_at`, oldest first, across every workspace, and compares each with the older posts of its board (a lower number); posts that existed before the migration are compared as the sweep reaches them. A merged post is marked checked with nothing to compare. A sweep stops comparing after 20 seconds and leaves the rest unchecked for the next one (it always gets through one post): comparing by meaning scans the board's vectors, about 0.15 ms a post at 1,536 dimensions on local Postgres 17, so a burst of new posts on a board of thousands takes more than one sweep.
- **Matching.** A title's key words are the similar-posts search's words (letters and digits, two characters or more, at most eight) without common English filler (`a`, `add`, `please`, `support`, `the`…). The search (`FeedbackPostRepo.similar`) finds up to 20 older posts, and each is scored by the share of the new title's key words found as whole words in its title. A pair needs two shared key words and a score of 0.5 or more; a post keeps its three closest pairs (then the most voted). A title with fewer than two key words gets none.
- **Matching by meaning** (only with an embedder: `AI_GATEWAY_API_KEY`, model `FEEDBACK_EMBEDDING_MODEL`, see [env](./env.md#public-api-host)). Each sweep first embeds up to 100 live posts that have no vector from the configured model for their current words (the ones not compared yet first, then the oldest; title, a blank line and body, cut at 4,000 characters), in one call, and stores each vector scaled to length 1. Then, after the title-word pairs, a post with fewer than three gets the older live posts of its board whose vectors from the same model have a cosine similarity of 0.8 or more, the closest first, up to three pairs in all; a pair the title words found keeps `fulltext` and its score. An embedder that fails is logged and the sweep goes on with title words, so those posts are compared without their vectors (they are embedded on a later sweep, for the posts after them).
- **Post embeddings** (`mocco_feedback_post_embeddings`): one row per post (`post_id` the key, an FK on `(post_id, workspace_id)` that cascades), with `model`, `dims`, `embedding` (`real[]`, checked to hold `dims` values), `content_hash` (sha256 of title, a blank line and body) and `created_at` (when the vector was made). Editing a post's title or body, or configuring another model, makes its vector due again; a merged post isn't embedded. Vectors are `real[]` and similarity is a dot product in SQL rather than pgvector, because the extension isn't on every Postgres Mocco runs on (the local and self-host `postgres` image, pglite in tests); with a board's posts in the thousands, the scan over one board is cheap. pgvector and an HNSW index can replace it when boards outgrow that.
- **One row per pair**, `post_id` the newer post and `candidate_post_id` the older one it may repeat, unique on the two, with `score` (0 to 1), `method` (`fulltext` or `embedding`) and `state` (`open` or `dismissed`). A pair already there, open or dismissed, is never inserted again, so a dismissed pair doesn't come back.
- **The queue** (`list`, `countOpen`) is a board's open pairs whose posts are both unmerged, the newest first: merging either post takes every pair it is in out of the queue, with no state change.
- **Dismissing** (`dismiss`) sets an open pair to `dismissed` with who and when, and records `feedback.duplicate.dismissed`. Another project's pair, or one already dismissed, is `FeedbackDuplicateNotFoundError` (NOT_FOUND).

## Intake

Requests captured elsewhere in Mocco become posts (#182); for now the source is a messenger conversation (`messenger_conversation`), and app reviews and forum threads join as they land. Migration 0085 adds `mocco_feedback_post_sources`: one row per (source, post) with the source's own id as text, the request's words (`excerpt`, at most 1000 characters), the requester's end-user id when the source knew it, and who converted it.

- **The port.** `IntakeService` reads sources only through `FeedbackSourceReader` (`read(scope, sourceId)` → a suggested title, the excerpt and the requester's end-user id, or undefined outside the project). Messenger implements it in `domain/messenger/feedback-source.ts`: the contact's public messages (never internal notes), the title from their first line (at most 80 characters, cut at a word), and the contact's app user id when they were signed in. The feedback composition root (`instance.ts`) passes the readers in; `feedback/` imports no other product's repos.
- **Preview** (`intakePreview`): the snapshot, the posts the source already became, and up to five of the board's live posts it may repeat (the [suggested duplicates](#suggested-duplicates) key words over the request, through the similar-posts search).
- **Convert** (`convertSource`): a new post on a board (title and details from the team), or the request added to an existing post (`intoPostId`; a merged one is `FeedbackPostMergedError`). A source that already became a post, converted again without `intoPostId`, answers that post (the one it was merged into, if it was) and records nothing. The requester votes for the post with source `intake` when the source knows them; a vote they had already stays the only one. A guest known only by an email address gets no vote: that address was never confirmed for the board. Each new link records `feedback.post.converted`.
- **Reading back.** `sourcePosts` lists the posts a source became (for the conversation page; a source outside the project is NOT_FOUND), and `postSources` a post's sources for the team. Sources are staff-only: excerpts quote the requester.
- **Erasing.** Erasing a messenger contact (privacy) deletes the sources made from their conversations; the posts stay, as the team's.

## GitHub links

Staff link a post to issues and pull requests in the repos linked to its project (#178). The link stores what GitHub last said about it, and webhooks keep that current; [shipping on release](#shipping-on-release) reads these rows. Migration 0087 adds two tables:

| Table | What it holds |
|---|---|
| `mocco_feedback_links` | A post's link: `repo_id`, `kind` (`issue` or `pull_request`), `external_number`, `external_node_id`, `title`, `url`, `state` (`open`, `closed`, or `merged` for a pull request only, DB-checked), `merge_commit_sha` and `merged_at` once merged, `created_by_user_id`, and `refreshed_at` (when GitHub last told us). Unique on `(post_id, repo_id, kind, external_number)`; indexed on `(repo_id, kind, external_number)` for the webhook fan-in |
| `mocco_feedback_link_closers` | The pull requests that close a linked issue when merged (GitHub's `closedByPullRequestsReferences`), in the issue's own repo: `pr_number`, `title`, `url`, `state`, `merge_commit_sha`, `merged_at`. Unique on `(link_id, pr_number)`; indexed on `(repo_id, pr_number)` |

- **Tenancy.** Both tables reference the repo through a composite FK on `(repo_id, workspace_id)` to `mocco_repos`, so a row can never pair a post with a repo another workspace registered, even through a direct insert. `LinkService` also requires the repo to be linked to the post's project (`mocco_project_repos`); any other repo is `FeedbackLinkRepoNotFoundError` (NOT_FOUND), checked before GitHub is asked anything. The read of those tables lives in `repos/tracker-repo.repo.ts` (read-only; the integration domain owns them).
- **The port.** `LinkService` reads GitHub only through `IssueTracker` (`domain/integration/ports.ts`): `search(repo, kind, query, limit)`, `get(repo, kind, number)` (null when the repo has none) and `closingPullRequests(repo, issueNumber)`. The GitHub adapter implements it: a number (`12`, `#12`) is a direct read; words go to `GET /search/issues` with `repo:owner/name` and `is:issue` or `is:pr` (words carrying a qualifier such as `repo:` are dropped, and results outside the repo are filtered out). A pull request is `merged` when GitHub says so, and only then keeps `merge_commit_sha` (GitHub fills it on open pull requests too, for its test merge). `feedback/` imports nothing from GitHub. The permissions this needs are in [GitHub App permissions](./github-app.md).
- **Linking** (`link`): the post (not a merged one: `FeedbackPostMergedError`), a repo of its project, and a number; the item is read from GitHub and stored. A number the repo doesn't have is `FeedbackLinkTargetNotFoundError` (NOT_FOUND), the same link again `FeedbackLinkExistsError` (CONFLICT), and a server without a GitHub App `FeedbackIssueTrackerUnavailableError` (BAD_REQUEST). An issue link resolves its closing pull requests right away (best-effort: the link stands if that read fails). Records `feedback.post.linked`. **Unlinking** (`unlink`) deletes the link and its closers and records `feedback.post.unlinked`.
- **Webhooks.** The deferred webhook pass hands `issues` and `pull_request` deliveries (every action) to `LinkService.applyProviderEvent` through `CommitSyncService.withTrackerEvents`, after resolving the repo through the installation's connection like every other event. Every link to that issue or pull request in the repo's workspace takes its title, state and merge commit, and for a pull request every closer row for it does too; an issue whose state changed has its closers resolved again. A delivery that matches no link is parked (logged with `console.warn`, never thrown), like an unknown repo or installation. A new pull request that says `Fixes #12` becomes a closer when the issue next changes state or is refreshed, not from its own event.
- **Refresh** (`feedback.links.refresh`, every 10 minutes): the 20 links not heard about for 6 hours, the longest ago first, are read again (and an issue's closers), for deliveries GitHub never sent. A link whose repo or target is gone keeps what it knew; a failure is logged; either way it waits its next turn. Without a GitHub App the job does nothing.

Not yet: MCP tools for links, and showing links on the public board (number and state only, per the design).

## Shipping on release

A release that contains a post's linked work suggests marking the post shipped (#179, [ADR 0031](../adr/0031-feedback-ships-on-the-release-registry-not-environments.md)). Migration 0088 adds the board's release policy, marks on links, `mocco_feedback_ship_suggestions`, and `source_run_id` on changelog entries.

**What counts as a release.** Mocco has no environments, so a board says which releases ship its posts. A release is the [release registry](./releases.md)'s `deploy.released`: a run that succeeded and passed at least one resumed gate. A run with no gate never ships a post. The board's release policy (all on `mocco_feedback_boards`, set with `BoardService.setReleasePolicy`, audited as `feedback.board.release_policy_changed`):

| Column | Default | Meaning |
|---|---|---|
| `release_repo_id` | null (off) | The repo whose releases count. It must be linked to the board's project (`FeedbackLinkRepoNotFoundError`, NOT_FOUND, otherwise), and the release must name that project. FK to `mocco_repos`, SET NULL |
| `release_step_name` | null (any) | Only a release whose run succeeded a step of this name counts (`deploy.released` carries `succeededSteps`) |
| `ship_policy` | `all_links_shipped` | `all_links_shipped`: every link that counts has shipped. `any_link_shipped`: one has |
| `ship_mode` | `suggest` | `suggest` asks the team; `auto_apply` marks the posts shipped itself |

**The detector** (`ShipDetector`, the `feedback.ship_detect` subscriber on `deploy.released`, `domain/feedback/subscribers.ts`) runs for each board whose release repo is the release's repo, in a project the release names, whose step (if any) succeeded:

1. **Candidates.** The board's links to the release repo that no release shipped yet: a merged pull request's merge commit, or the merge commits of an issue's merged closing pull requests.
2. **Containment.** A merge commit that is the released commit is contained without asking. Any other is asked through the `CommitAncestry` port (`containsCommit(repo, ancestor, head)`; the GitHub adapter calls the compare API, `ahead` or `identical` is contained, `behind`, `diverged` or a 404 is not). Commit order in `mocco_commits` isn't used: a force-push makes it lie. `AncestryChecks` caches each answer for the release and asks at most 50 times (`SHIP_ANCESTRY_CALL_CAP`); past the cap, without a GitHub App, or when GitHub fails (logged), a link isn't decided and waits for the next release.
3. **Marks.** Each contained link gets `shipped_run_id` and `shipped_at`: the first release that contained it, never moved by a later one.
4. **Posts.** Every post of the board with a link this run shipped is checked against the policy. Shipped links always count; an abandoned link doesn't (a pull request closed unmerged, an issue closed with no merged pull request); every other link (open, or merged and not released yet, in any repo) counts. A merged duplicate, a post already shipped, and a post waiting on a suggestion from an earlier run are skipped.
5. **Suggestions.** One `mocco_feedback_ship_suggestions` row per (post, run), unique, with the released `commit_sha` and the resumed gates' names (`gate_names`, the banner's "approved by"), `state` `pending`. Each new one records `feedback.shipped_suggested` (no actor; the run, commit, gates and draft).
6. **Draft.** One draft changelog entry per board and run (`source_run_id`, unique per board) groups every post the run suggested there, by number: the title is the first post's (and "and N more"), the body a line per post with its pull requests linked. `ChangelogService.draftForRun` adds posts to it on a later pass and never touches its words. Each suggestion points at it (`changelog_entry_id`, SET NULL when the entry is deleted).
7. **Auto-apply.** On a board in `auto_apply` mode the run's suggestions are applied at once (below), as no one.

Every step is idempotent: a release delivered again marks nothing new (marks stay), inserts no suggestion (the unique pair), and drafts no second entry, so the at-least-once bus delivers it effectively once. A failure throws and the delivery job retries. The release registry's reconcile publishes releases the event path missed, so a missed release still reaches the detector.

**Deciding** (`ShipSuggestionService`): `listPending` groups a board's waiting suggestions by run, the newest first. `accept` takes every waiting suggestion of a run on the board in one transaction (the suggestions locked, then the posts in id order) and moves each post to `shipped` with a status change of reason `ship_suggestion` by the team member; a post merged or shipped meanwhile has its suggestion decided with no change. The suggestions become `accepted` with who and when, and each shipped post records `feedback.shipped`. The status change is like any other, so [status mail](#status-mail) follows. `autoApply` does the same as no one, with reason `auto_apply` and state `auto_applied`. `dismiss` sets them `dismissed` and leaves the posts (not audited). A run with nothing waiting on the board is `FeedbackShipSuggestionNotFoundError` (NOT_FOUND). The draft stays a draft either way: publishing it is the team's call.

Agents list and decide suggestions through three MCP tools ([MCP tools](#mcp-tools)); `listPending` gives each post's `mergedIntoPostId` so they can say a merged post is left as it is.

Not yet: the staff Slack notice, and noticing a later release that no longer contains a shipped link (a revert or rollback).

## Audit

`feedback.board.created`, `feedback.board.deleted`, `feedback.post.status_changed` (with `from`, `to`, the board and the post number) and `feedback.post.merged` (on the source, with the board, both post numbers, `intoPostId` and `votesAdded`) are appended after their transaction commits, and `feedback.duplicate.dismissed` (on the newer post, with the board and `candidatePostId`) when staff set a [suggested pair](#suggested-duplicates) aside, and `feedback.post.converted` (with the board, the post number, the source and whether the post was new) when a request becomes a post or joins one ([intake](#intake)), and `feedback.post.linked` (with the board, the post number, the repo, kind and number) and `feedback.post.unlinked` (with the kind, number and URL) for [GitHub links](#github-links), and `feedback.board.release_policy_changed`, `feedback.shipped_suggested` and `feedback.shipped` for [shipping on release](#shipping-on-release). Category and post edits aren't audited. The changelog's audit actions are under [Changelog](#changelog).

## The feedback router

`feedback.*` procedures all use `productProcedure(Products.feedback)`: the caller must be a member of the workspace (NOT_FOUND otherwise), the project must belong to it (NOT_FOUND), and the feedback product must be enabled (FORBIDDEN). The same chain maps the domain's errors: `FeedbackBoardNotFoundError`, `FeedbackCategoryNotFoundError`, `FeedbackPostNotFoundError`, `FeedbackVoteNotFoundError`, `FeedbackLinkRepoNotFoundError`, `FeedbackLinkTargetNotFoundError`, `FeedbackLinkNotFoundError` and `FeedbackShipSuggestionNotFoundError` are NOT_FOUND; `FeedbackSlugTakenError`, `FeedbackStatusUnchangedError`, `FeedbackStatusMovedError`, `FeedbackPostMergedError` and `FeedbackLinkExistsError` are CONFLICT; `FeedbackOfficialInternalError`, `FeedbackMergeInvalidError` and `FeedbackIssueTrackerUnavailableError` are BAD_REQUEST. Entities are looked up within the caller's workspace and project, so another tenant's id is NOT_FOUND. A test calls every procedure as a non-member and with another tenant's ids.

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
| `intakePreview`, `convertSource`, `sourcePosts`, `postSources` | [Intake](#intake): preview a source on a board, convert it, the posts a source became, and a post's sources |
| `linkRepos`, `linkSearch`, `links`, `link`, `unlink` | [GitHub links](#github-links): the project's repos, a search of one (at most `FEEDBACK_LINK_SEARCH_LIMIT`, 10), a post's links with their closers, linking by number, and removing a link |
| `setReleasePolicy`, `shipSuggestions`, `acceptShipSuggestions`, `dismissShipSuggestions` | [Shipping on release](#shipping-on-release): set a board's release policy; its waiting suggestions by run; mark a run's posts shipped as the caller, or set them aside |
| `duplicates`, `dismissDuplicate` | A board's [suggested pairs](#suggested-duplicates) still to decide, with both posts and the open count; set one aside |

## The console

The project's **Feedback** section (`pages/workspaces/[id]/p/[projectId]/feedback/`, #175) appears once the workspace turns the feedback product on (Products page). It reads and writes only through the `feedback.*` procedures above.

- **Inbox** (`/feedback`, `components/feedback-console/inbox.tsx`): one board's posts, with the board, status tab, category and sort in the query string (`?board=ideas&status=all&category=mobile&sort=top`); defaults (the first board, under review, every category, newest) are left out of the address. Each row shows the counted votes, the post's number, title, status, category, public comment count and whether the team or an end user posted it; a merged duplicate carries a "Merged" badge. 50 posts a page with previous and next; the list refreshes every 30 seconds (no realtime in v1). A public board links to its page on the help site when the project has one.
- **Boards** (`/feedback/boards`, `components/feedback-console/boards.tsx`): create a board (the address is derived from the name until edited, and must match `FEEDBACK_SLUG_PATTERN`), rename it, change its address or visibility, delete it after a confirmation, and add, rename or delete its categories (a new category's slug comes from its name). **Shipping on release** sets the [release policy](#shipping-on-release): the release repository (one of the project's, or Off), an optional release step, when a post counts as shipped, and **Mark posts shipped without asking** (`auto_apply`, off by default). A project without boards opens on the create form.
- **Ship banner** (`components/feedback-console/ship-suggestions.tsx`, on the inbox above the posts): one banner per release run with waiting suggestions, "N posts shipped in run abc1234 (approved by sre)", linking the run and listing the posts with their votes; **Mark shipped** calls `acceptShipSuggestions`, **Dismiss** `dismissShipSuggestions`, and **Draft changelog entry** opens the run's draft. Refreshes every 30 seconds.

- **A post** (`/feedback/posts/<id>`, `components/feedback-console/post.tsx`, opened from an inbox row): its description (editable with the title), the status and category selects, comments with the composer's three kinds (reply, official response, internal note; internal notes are tinted and never public), the votes (pending ones marked) with recording a vote for a user id and removing one, the follower count, and the status history with who changed what. **Merge into another post…** searches the board's 100 most voted posts by title or number (client-side) and calls `mergePost`; a merged post says which post it went into, its status is fixed, and its votes are read-only (`lockLivePost` refuses them). Team members' names come from `workspace.members`; an email voter shows as the address (`FEEDBACK_EMAIL_END_USER_PREFIX`, now in `@mocco/common/feedback`).
- **GitHub** (`components/feedback-console/github-links.tsx`, beside the triage controls): the post's links, each with its kind, repo, number, title (linking to GitHub), a state badge (open, merged, closed), the merge commit's short SHA, and an issue's closing pull requests with their states; **Unlink** removes one. **Link an issue or pull request…** picks one of the project's repos, issue or pull request, and searches by words or `#number` (an empty search lists the recently updated ones); clicking a result links it. A project without repos is pointed at its project page, and a server without a GitHub App shows the error from `linkSearch`.
- **From conversations**: a post's page lists the conversations it came from, quoted, each linking back to the conversation and naming the requester who voted. The messenger conversation page has a **Feedback** panel (`components/feedback-console/convert-to-feedback.tsx`, when the workspace has the feedback product): the posts the conversation became, and **Convert to feedback**, which pre-fills a title and details from the request on the first board (or the one picked), offers **Add to #N** for the board's similar posts, and **Create post**. A conversation that became a post already is only offered other posts.
- **Possible duplicates** (`/feedback/duplicates?board=`, `components/feedback-console/duplicates.tsx`, linked from the inbox with the open count): the board's [suggested pairs](#suggested-duplicates), newest first, each with both posts' numbers, titles, statuses and votes and the share of title words they have in common. **Merge #new into #old** calls `mergePost`; **Not the same** calls `dismissDuplicate`.
- **Changelog** (`/feedback/changelog?board=&state=`, `components/feedback-console/changelog.tsx`, linked from the inbox): a board's entries by state (Draft, Scheduled, Published, All), newest first, and **New entry**, which creates a draft from a title and opens it. The editor (`/feedback/changelog/<id>`, `changelog-entry.tsx`) edits the title, the address, the tags, the Markdown text beside the public page's rendering (`helpArticleBlocks`) and the posts it announces (searched among the board's 100 most voted, merged duplicates left out). **Publish now** and **Schedule** (a `datetime-local` in the viewer's time zone, sent as an absolute time) save unsaved edits first. **Unpublish** or **Cancel the schedule** takes it back to a draft, and **Delete entry** asks first. A published entry links its public page.

## Changelog

A board's changelog (#176): entries the team writes in Markdown, each announcing posts that shipped. The model, the service, the `changelog` router and the publish job, the public changelog, `/v1` and the console's changelog (below).

**Tables.** `mocco_changelog_entries` (board-scoped through the boards' composite FK, so an entry can't point at another tenant's board; deleting the board deletes its entries): `slug` (unique per board, `CHANGELOG_SLUG_PATTERN`, 1–80 characters), `title`, `body_md`, `tags` (a `text[]` of `new`, `improved`, `fixed`, DB-checked; the design's separate tags table wasn't needed), `state` (`draft`, `scheduled`, `published`), `publish_at` (set exactly while scheduled) and `published_at` (set exactly while published), both held by one CHECK, and `created_by_user_id` (SET NULL). `mocco_changelog_entry_posts` links an entry to the posts it announces, in order (`position`); deleting either side removes the link. `source_run_id` (migration 0088, SET NULL) is the release run whose shipped posts the ship detector drafted the entry from, unique per board ([shipping on release](#shipping-on-release)); null for an entry the team started.

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

## Status mail

When a post moves to planned, in progress, shipped or closed (`FEEDBACK_NOTIFIED_STATUSES`), its followers who voted by email hear about it (#180). Signed-in end users' addresses aren't stored (`EndUserTokenService` drops every claim but `sub` and `exp`), so Mocco doesn't mail them; their app tells them.

- **Settling.** `mocco_feedback_status_changes.notified_at` marks a change whose mail is decided. Migration 0083 sets it on every change made before, so none of those is mailed. The `feedback.status.mail` job runs every minute. `StatusMailService.fanOutDue` takes changes made at least two minutes ago (`StatusMailPolicy.delayMs`, an undo window), 50 a run, `FOR UPDATE SKIP LOCKED`. It settles with no mail any change the post has since moved on from (only the newest is mailed), one to under review, one from creating or merging a post, one on a private board or a merged post, and any change while this deployment sends no email.
- **Who.** Each remaining change queues a row in `mocco_feedback_status_mails` (unique per change and end user, so a repeated fan-out queues nothing new) for every follower whose id starts with `email:`, who hasn't unsubscribed, and whose vote on the post counts. Voting by email subscribes before the address is confirmed, so the counted vote is what keeps an unconfirmed address from being mailed. One `INSERT … SELECT` queues any number of followers.
- **Sending.** `sendQueued` claims up to 200 queued mails a run (`sending`, `attempts + 1`, `SKIP LOCKED`). It skips a follower who unsubscribed meanwhile (`skipped`), sends the rest one at a time, and marks each `sent`. A transient failure is queued again until 5 attempts, then `failed`; a permanent one is `failed` at once. A claim older than 15 minutes belongs to a run that died, perhaps after the relay took the mail, so it is marked `failed`, never resent.
- **The mail** (`status-mail.ts`). It names the post and its new status, links the post's public page (the project's help site, `/feedback/<board>/<number>`) and, for shipped, the newest published changelog entry that announced it. It has the footer "You get this because you voted for it" and the same signed, non-expiring one-click unsubscribe link as the vote mail, with `List-Unsubscribe` and `List-Unsubscribe-Post` headers. Customer text is escaped in HTML.

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

Three more (`transport/mcp/tools/feedback-shipping.ts`, #179) sit over `ShipSuggestionService` and `ChangelogService.get` behind the same `ProjectScope` check, for [shipping on release](#shipping-on-release):

| Tool | Over | Answers or does |
|---|---|---|
| `mocco_feedback_ship_suggestions_list` | `BoardService.listBoards`, `ShipSuggestionService.listPending`, `ChangelogService.get` | The release runs waiting for the team on one board (`boardId`) or every board of the project, the newest first: board, run id, released commit, `approvedBy` (the resumed gates), when suggested, and each post (suggestion id, post id, number, title, status, votes, and `mergedIntoPostId` for a post merged since), with the draft changelog entry's id, title and state (null when it was deleted); detailed adds the draft's slug, Markdown body and post ids |
| `mocco_feedback_ship_suggestions_accept` | `ShipSuggestionService.accept` | Marks every post of a run still waiting on a board shipped, as the caller |
| `mocco_feedback_ship_suggestions_dismiss` | `ShipSuggestionService.dismiss` | Sets a run's waiting suggestions on a board aside, as the caller |

The two changes decide a run on a board at a time, as the inbox banner does, and have the same locks: `feedback:write`, the opt-in and a confirmation round trip. The confirmation names the run, its commit and approver, and each post with its status now and what happens to it (`in_progress → shipped`, or left as it is when merged or shipped since); accepting also says email voters are mailed and the draft stays a draft. It is bound to the board, the run, the waiting suggestions' ids and each post's status and `mergedIntoPostId`, so a suggestion decided or added, or a post moved or merged, before the answer is refused as a different change and the next call asks with what is there then. A run with nothing waiting on the board (decided already, unknown, or another project's) is refused before asking with `FeedbackShipSuggestionNotFoundError`'s message, and so is accepting a run whose every post was merged or shipped since: nothing would ship, so the refusal says to dismiss it. `accept` locks the suggestions and posts again, so a post merged in the gap is decided without a change. The changes are the console's: reason `ship_suggestion` and `feedback.shipped` naming the caller, and [status mail](#status-mail) follows.

Seventeen more close the gap between the console and agents (ADR 0025), behind the same `ProjectScope` check. Every `feedback` procedure now has a tool, except `deleteBoard`, which stays in the console on purpose: it deletes every post, vote, comment, follower, source and changelog entry on the board with no undo. The [GitHub link](#github-links) tools come in their own change.

| Tool | Over | Answers or does |
|---|---|---|
| `mocco_feedback_board_get` | `BoardService.getBoard` | One board (id, slug, name, public) with its release policy and categories in order; detailed adds category slugs and positions and the board's timestamps |
| `mocco_feedback_board_create` | `BoardService.createBoard` | Creates a board (slug, name, public by default) as the caller; audited |
| `mocco_feedback_board_update` | `BoardService.updateBoard` | Changes a board's name, slug or visibility; only the fields given |
| `mocco_feedback_board_release_policy_set` | `BoardService.setReleasePolicy` | Sets the [release policy](#shipping-on-release); only the fields given; audited |
| `mocco_feedback_category_create`, `_update`, `_delete` | `BoardService.createCategory`, `updateCategory`, `deleteCategory` | Adds, changes (only the fields given) or deletes a board's category; the tools take the board too, to show the category |
| `mocco_feedback_post_create` | `PostService.create` | Writes a post as the caller (title, body, category, first status) |
| `mocco_feedback_post_update` | `PostService.update` | Edits a post's title, body or category (`null` uncategorizes); only the fields given |
| `mocco_feedback_subscribers_list` | `SubscriptionService.list` | A post's current followers, oldest first, `limit` up to 99, `offset`, `nextOffset` |
| `mocco_feedback_post_unvote` | `VoteService.unvote` | Removes an end user's vote on their behalf; they keep following |
| `mocco_feedback_duplicates_list` | `DuplicateService.list`, `countOpen` | A board's [suggested pairs](#suggested-duplicates) with both posts (id, number, title, status, votes) and the open count; detailed adds the start of both bodies |
| `mocco_feedback_duplicate_dismiss` | `DuplicateService.requireOpen`, `dismiss` | Sets an open pair aside as the caller; audited |
| `mocco_feedback_intake_preview` | `IntakeService.preview` | A request on a board: suggested title, words, requester, the posts it became and up to five similar posts |
| `mocco_feedback_intake_convert` | `IntakeService.preview`, `convert` | Makes a request a new post or adds it to one, as the caller; audited |
| `mocco_feedback_source_posts_list` | `IntakeService.postsOf` | The posts a request became |
| `mocco_feedback_post_sources_list` | `PostService.requirePost`, `IntakeService.sourcesOf` | A post's requests with their words (cut at 500 characters unless detailed, which adds who converted each) |

The changes have the locks of every other feedback change: `feedback:write`, the opt-in and a confirmation round trip naming exactly what would change. Edits take only the fields given and answer without asking when nothing would change; each confirmation records the current values (a post's body as a hash), so an edit by anyone before the answer is refused as a different change. A taken board or category slug, a category of another board, and an incomplete or merged conversion target are refused before asking. Deleting a category says how many posts lose it (`or more` past a page). A dismissal reads the pair with `DuplicateService.requireOpen` (new: one open pair whose posts are both unmerged, else `FeedbackDuplicateNotFoundError`) and a conversion reads the preview; a request that became a post already answers that post without asking. Removing a vote is bound to the vote's state, and a merged post is refused.

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

## Public board pages

A project's public boards have pages on its help center's site (#175, [ADR 0015](../adr/0015-public-sites-use-isr-on-the-pages-router.md)): `/feedback/<board>` lists a board, `/feedback/<board>/roadmap` shows its roadmap and `/feedback/<board>/<number>` shows one post, so `showyourtime.help.mocco.club/feedback/ideas/12`, or the site's custom domain. The help site is the project's one public host so far; the site's slug names the project the way a key does on `/v1`. A project without a help site has no board pages. Customer guide: [Open a public feedback board](../customer/feedback/public-board.md).

**Rendering.** `pages/_sites/[site]/feedback/[board]/index.tsx`, `roadmap.tsx` and `[number].tsx` are ISR (`getStaticProps`, `fallback: 'blocking'`, 60 seconds), so a crawler or a browser without JavaScript reads the board and its posts. Their data comes from `@mocco/backend/sites/feedback` (`transport/sites/feedback.ts`), which reads through `PublicBoardService` and parses every post, comment and board through the same `@mocco/common/feedback-v1` schemas `/v1` answers with. A private or missing board, an unknown number and an unknown site are 404. A merged duplicate's number redirects permanently (308) to the post it was merged into (`PublicBoardService.postOnBoard`, a post by its number on the board). A post's Markdown becomes the render tree on the server, with links and images shown as their text, so the board is no place to plant links. Comments are plain text.

**SEO.** Each page has its canonical and Open Graph URLs on the site's origin (`helpSiteOrigin`), a signed share card (ADR 0030), a `BreadcrumbList`, and on a post a `DiscussionForumPosting` with its vote and comment counts. Pages carry `referrer: no-referrer`. Without `HELP_SITES_DOMAIN` (no origin to be canonical on) a page is `noindex`.

**The browser's calls.** Filters (`?status=&category=&sort=`, in the address), the next page, the live count, the viewer's own vote, posting, voting, comments, similar posts and voting by email go to `/api/ext/sites/{site}/feedback/*` (`transport/ext/sites/feedback.ts`). These are the `/v1/feedback` routes themselves, mounted behind the site instead of a key (`createFeedbackRoutes` takes a gate): the site's project is the principal, as a publishable key with `feedback:read` and `feedback:write` would be, after a per-address limit (120 a minute). So the projection, the end-user token checks and the per-end-user and per-address [limits](#the-public-v1-surface) are the same code. Answers are `no-store`. It is not a versioned API: apps and widgets use `/v1` with their key.

**Signing in.** An app links its signed-in user to the board with `?token=<the HS256 end-user token>`. The page keeps the token in `sessionStorage` for that tab, takes it out of the address through the router, and sends it as `Authorization: Bearer`. A refused or expired token is forgotten, and the page falls back to voting by email. Without a token a visitor reads and votes by email; posting and commenting need a token.

A test (`transport/ext/sites/feedback.test.ts`) builds both pages' data and calls the routes after an internal note, an official response, another end user's comment and a post written by an email-like end-user id, and checks that none of the note, the team member's id, the end users' ids, the email or the workspace, project and board ids is in any page or answer.

**Roadmap.** `/feedback/<board>/roadmap` shows the planned, in progress and shipped columns side by side, the 50 most voted posts of each (`PublicBoardService.roadmap`, the same columns `GET /boards/{slug}/roadmap` answers), merged duplicates left out. The category filter (`?category=<slug>`) is in the address and narrows the columns already on the page in the browser, so a filtered roadmap can be shared as a link; without JavaScript, and for crawlers, every category shows, and the canonical URL has no filter.

**Sitemap.** The help site's `/sitemap.xml` also lists each public board, its roadmap and its live posts (merged duplicates left out), with their last change as `lastmod`, at most 10,000 posts per project, the most recently changed first (`PublicBoardService.sitemap`). Board pages are served in one language, so they carry no `hreflang` alternates.
