---
title: Publish a help center
description: Set up a public help site for a project, write articles in Markdown with a live preview, publish them, and restore an earlier version — and how readers reach the site.
type: guide
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [customer, help-center, guide]
related:
  - ../../reference/help-center.md
  - ../../adr/0015-public-sites-use-isr-on-the-pages-router.md
---

# Publish a help center

A help center is a public site with your product's help articles. You write them in Mocco in Markdown, see each one as readers will while you type, and publish when it's ready. Readers open the site in a browser, or from a link in your app.

## 1. Turn on the help center

A workspace member turns on **Help center** on the workspace's **Products** page. Each project then shows a **Help center** tab.

## 2. Set up the site

On the project's **Help center** tab, pick:

- **Address**: the site's name in its web address, such as `showyourtime` for `showyourtime.help.mocco.club`. It must be unique across Mocco.
- **Written in**: the language you write articles in.
- **Also offered in**: the languages you plan to offer. Until an article is translated, readers who pick another language get it in the language you write in.

Then choose **Set up help center**.

![Setting up a help center: the address, the language articles are written in, and the other languages offered](./images/setup.png)

## 3. Organize and add articles

A help center has **collections** (the top level, such as "Getting started"), which hold **sections** (such as "Basics"), which hold **articles**. Add a collection at the bottom of the tab, a section inside a collection, and an article inside a section. A new article opens in the editor.

The tab shows every article with its state: **Draft** has never been published, **Published** is on the site, and **Unpublished changes** means the site still shows an earlier version than the one you saved. The site's address is at the top; select it to open the site.

![The Help center tab: a collection with a section and two published articles, and the site's address](./images/help-center.png)

## 4. Write and publish

The editor has the article's title and its text in Markdown on the left, and the article as readers will see it on the right, updated as you type. You can use headings (`##`), numbered and bulleted lists, **bold**, links, notes (lines starting with `>`) and tables. Links can go to web pages (`https://…`), email addresses (`mailto:…`) or other pages of the site (`/en/articles/…`). Images must be `https://` addresses.

- **Save draft** keeps your changes without touching the site.
- **Publish** puts the saved draft on the site. Save first; **Publish** is unavailable while you have unsaved changes.
- **Unpublish** takes the article off the site. Its text and history stay.
- **Delete article** removes it and its history, after you confirm.

![Editing an article: Markdown on the left, the preview on the right, and Unpublished changes after saving](./images/editor.png)

Every save is kept in **History** below the editor. **Restore** makes an earlier version the draft again, as a new save, so nothing in the history is lost. Publish it to put it back on the site.

## 5. What readers see

The site lists your collections and their articles in the language the reader picked, with a language switcher at the top. Each article has its own address, `/<language>/articles/<id>-<name>`. The `<id>` part never changes, so links keep working if you rename an article. A published change appears on the site within a minute.

![A published article on the public help site, with the article list and the language switcher](./images/public-article.png)
