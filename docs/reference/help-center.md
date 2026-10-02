---
title: Help center
description: How Mocco stores a project's help center — a public slug and languages, collections → sections → articles, append-only revisions with publish and restore — and the operator and public-read services over them.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-02
confidence: high
owner: andrea
tags: [reference, help-center, support]
related:
  - ../specs/2026-09-24-help-center-design.md
  - ./project.md
code_refs:
  - packages/backend/src/domain/helpcenter/HelpAuthoringService.ts
  - packages/backend/src/domain/helpcenter/HelpPublicReadService.ts
  - packages/common/src/help.ts
---

# Help center

The first slice of the [help center design](../specs/2026-09-24-help-center-design.md) (#96): the data model and the services to write, publish and read a help center. The public site, the editor, import, translation, search and custom domains come in later slices.

## Sites

A project has at most one help site (`mocco_help_sites`, migration 0042): a public `slug` (unique across Mocco; the site will be served at `<slug>.help.<domain>` until a custom domain is bound), a `source_locale` the team writes in, and `locales`, the languages it is translated into (never the source). `help.enable` and `help.updateSite` are audited as `help.site.enabled` / `help.site.changed`; a taken slug is a CONFLICT.

## Collections, sections, articles

Collections (`mocco_help_collections`, with a slug unique in the project) hold sections (`mocco_help_sections`), which hold articles (`mocco_help_articles`). New nodes go last; deleting a collection or section deletes what it holds.

An article has a stable `short_id` (6 characters, unique in the project) and a cosmetic `slug`. Its public path is `/{locale}/articles/{short_id}-{slug}`; a stale slug resolves to the same article and the reader gets the canonical path back to redirect to.

## Revisions and publishing

Text lives in `mocco_help_revisions`, append-only, one row per save: locale, title, Markdown body, a `content_hash` (sha256 of the normalized title and body; translations will compare against it) and a `kind` (`source_edit`, `restore`, `import`). The article points at its `draft_revision_id` and its `published_revision_id`.

- **Save** writes a new revision and makes it the draft. The public site keeps the published one.
- **Publish** makes the draft the published revision (`help.article.published`, audited). Publishing with no draft is a CONFLICT.
- **Unpublish** takes the article off the public site; text and history stay (`help.article.unpublished`).
- **Restore** copies an old revision into a new `restore` revision that becomes the draft, so history stays append-only.
- **Delete** removes the article and its revisions (`help.article.deleted`).

## Public read

`HelpPublicReadService` reads by the site's slug, with no session: the site, the published tree in a language, a published article by its URL ref, and old paths in `mocco_help_redirects` (an imported site's URLs). A language the site doesn't have is served in the source language. Drafts never appear.

## Operator API

The `help` tRPC router (`productProcedure(Products.helpcenter)`): `site`, `enable`, `updateSite`, `tree`, `createCollection`, `deleteCollection`, `createSection`, `deleteSection`, `createArticle`, `article`, `saveDraft`, `publish`, `unpublish`, `deleteArticle`, `history`, `restore`.
