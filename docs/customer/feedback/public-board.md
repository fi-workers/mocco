---
title: Open a public feedback board
description: Put a project's feedback board on the web for your users, where they read ideas, filter them, post their own, vote and comment — how to publish it, how your app signs its users in to it, and what visitors without an account can do.
type: guide
status: active
created: 2026-10-06
updated: 2026-10-16
confidence: high
owner: andrea
tags: [customer, feedback, guide]
related:
  - ../../reference/feedback.md
  - ../help/help-center.md
  - ../../adr/0015-public-sites-use-isr-on-the-pages-router.md
---

# Open a public feedback board

A feedback board collects what your users want next. On its public page they read the ideas others posted, vote for the ones they want, comment, and post their own. Your team sees the same posts in Mocco, answers them and moves them from under review to planned, in progress and shipped.

## 1. Before you start

The public board is served on your project's help center site, so the project needs one (see [Publish a help center](../help/help-center.md); the site doesn't need any articles). A board whose site is `showyourtime.help.mocco.club` is at:

```text
https://showyourtime.help.mocco.club/feedback/<board>
```

When the help center has its own domain, such as `help.showyourtime.app`, the board is there too: `https://help.showyourtime.app/feedback/<board>`.

## 2. Create a board

Turn on **Feedback board** on the workspace's **Products** page. The project then has a **Feedback** section. A project without boards opens on the form for its first one: give it a name, and its address follows the name (`Feature requests` → `/feedback/feature-requests`) unless you change it.

**Manage boards** lists every board with its public address. There you rename a board, change its address, make it private, delete it, and add or rename its categories. Users pick a category when they post, and the board and roadmap filter by it. Deleting a category keeps its posts, uncategorized.

![Managing boards and their categories](./images/feedback-console-boards.png)

Boards are public when they are created. A board marked private has no public page. Changing a board's address changes its public link, so links shared before stop working.

## 3. What visitors see

The board lists its posts, most voted first. Anyone can read it, and search engines index it. Each post shows its votes, its status and how many comments it has.

![A public feedback board with its posts, most voted first](./images/feedback-board.png)

**Top** and **New** sort the list. The status and category buttons filter it, and the filter is kept in the address (`?status=planned&category=mobile`), so a filtered list can be shared as a link. Duplicates your team merged into another post are left out.

A post's page has its description, the team's official response, and the public comments. Your team's internal notes never appear on the public page, and comments never show who wrote them: they read "Official response", "The team", "A user", or "You" for the reader's own.

![A post with its votes, the official response and comments](./images/feedback-post.png)

A merged duplicate's address sends the reader to the post it was merged into.

## 4. Sign your users in from your app

Posting and commenting need to know who the user is. Your app's server signs a short-lived token for its signed-in user, the same token your app sends to the feedback API (see [In-app contact with Mocco Messenger](../messenger/contact-us.md) for the identity secret). It is an HS256 JWT signed with the project's identity secret (the one Messenger setup shows), with the user's id as `sub` and an expiry at most an hour ahead.

Link to the board with the token in the address:

```ts
import { SignJWT } from 'jose';

// On your server, for the signed-in user.
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(user.id)
  .setIssuedAt(now)
  .setExpirationTime(now + 15 * 60)
  .sign(new TextEncoder().encode(process.env.MOCCO_IDENTITY_SECRET));

const boardUrl = `https://showyourtime.help.mocco.club/feedback/ideas?token=${token}`;
```

The page keeps the token for that browser tab and removes it from the address, so it isn't bookmarked or passed on. When the token expires, the user follows the link from your app again.

A signed-in user can post an idea. While they type a title, the board shows similar posts, so they can vote on one of those instead of posting a duplicate. A new post starts **Under review** with the author's own vote.

![Posting an idea, with similar posts suggested while typing](./images/feedback-similar.png)

On a post, a signed-in user votes with one click, and clicking again takes the vote back. The count updates at once. They can also comment.

## 5. Visitors without an account

Someone your app hasn't signed in can still vote, with their email address. Mocco mails them a link, and the vote counts once they open it. They can't post or comment.

![Voting by email: the vote counts once the mailed link is opened](./images/feedback-email-vote.png)

Voting by email needs Mocco to send mail. On a self-hosted Mocco without an email sender, the form says it isn't available.

## 6. Triage in the inbox

The **Feedback** section opens on the inbox: one board's posts, under review and newest first. Pick another board, a status (or **All**), a category and an order (**Newest**, **Most voted** or **By status**). The choice stays in the address, so you can bookmark a view or send it to a teammate. Each post shows its votes, its number on the board, its status, how many public comments it has and whether your team or a user posted it. The list refreshes every 30 seconds while open.

![The inbox: every status, most voted first](./images/feedback-console-inbox.png)

Open a post to work on it:

- **Status** moves it along. Everyone following it hears about the change, and planned, in progress and shipped posts appear on the roadmap.
- **Category** files it, or **No category** takes it out of one.
- **Comment** in one of three ways. A **Reply** is public. The **Official response** is your team's answer, highlighted among the public comments. An **Internal note** stays in Mocco, and visitors never see it.
- **Votes** lists who voted. A pending vote waits for its email to be confirmed. When a user asks for something by email or on a call, record their vote with the id your app knows them by.
- **Merge into another post…** handles duplicates. Search the board by title or number and pick the post to keep. The duplicate's votes and followers move there, each person counted once, and the duplicate's public address sends readers to it.

![A post in Mocco: status, category, comments with an internal note and the official response, and votes](./images/feedback-console-post.png)

## 7. Limits

Each user can vote 30 times, comment 20 times and post 5 times an hour, and one network address can make 120 changes an hour, whoever signs in. An email address gets 3 vote mails an hour.

The list a search engine or a first-time visitor sees is refreshed at least once a minute. Vote counts on a post's page are always current.
