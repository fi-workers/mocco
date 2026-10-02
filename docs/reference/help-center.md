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

The [help center design](../specs/2026-09-24-help-center-design.md) (#96) so far: the data model, the services to write, publish and read a help center, the public site and the console editor. Import, translation, search and custom domains come in later slices.

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

## Public site

With `HELP_SITES_DOMAIN` set, `https://<slug>.<domain>/` serves the site ([ADR 0015](../adr/0015-public-sites-use-isr-on-the-pages-router.md)): `/` redirects to the source language, `/{locale}` lists the published collections, `/{locale}/articles/{shortId}-{slug}` shows an article (a stale slug or a missing language redirects to the canonical path), and an unknown site is a 404. Pages are generated on first request and regenerated at most every 60 seconds, so a publish shows up within a minute. Article Markdown renders through the same tree as the customer guides; links may be `http(s)`, `mailto`, site paths or anchors, and images must be `https`.

## Custom domains

`HELP_CUSTOM_DOMAINS` maps a customer's domain to a site slug (`help.example.com=example`); `next.config.ts` adds a host rewrite per pair, alongside the `<slug>.<HELP_SITES_DOMAIN>` one, so the site's pages, redirects and old paths all work on that host. It is set per deployment for now: a domain needs adding to the Vercel project (and its DNS pointing there) anyway. Verifying domains from the console, through the Vercel Domains API, comes later.

## Console

The project's **Help center** tab (shown once the product is on) sets the site up (address, source language, offered languages), lists collections → sections → articles with their state (Draft, Published, Unpublished changes), and adds each level. The article editor shows the Markdown beside a live preview rendered by the same tree as the public site (`lib/help-markdown.ts`), with Save draft, Publish (only with no unsaved changes), Unpublish, Delete and the revision history with Restore ([customer guide](../customer/help/help-center.md)).

## Translation

Each article has a translation per offered language in `mocco_help_translations` (migration 0043): a state (`pending`, `auto` for machine text, `reviewed` for a person's text, `failed`), the current text as a revision in that language (`machine` or `human_edit`), and the content hash of the published source it was made from. A translation is **stale** when that hash differs from the current published source; staleness is derived, not stored.

- **On publish**, `HelpTranslationService.onPublished` queues a `help.translate` job per offered language, except languages with a reviewed translation (deduped per article and language).
- **The job** sends the published title and Markdown to the `Translator` port. The production driver is `AiGatewayTranslator`, an AI Gateway chat completion asking for `{title, body}` JSON; it exists only with `AI_GATEWAY_API_KEY`. The answer must keep the source's structure (`translate/validate.ts`: the same heading levels, identical code fences, the same link and image targets), or it is refused and the translation is `failed` with the reason. An outage or rate limit throws, so the job retries. A translation already made from the current source is not redone.
- **A person's text** (`help.saveTranslation`) is stored as `reviewed` and is never overwritten by the machine; when the source changes it shows as stale. `help.retranslate` asks the machine again for one language, replacing a reviewed text too.
- **The console**: the article editor's **Translations** section lists each offered language with its state (Machine translated, Reviewed, Source changed, Failed with the reason, Not translated), an editor with a live preview to write or fix one (saved as reviewed), and **Translate again** (confirmed first on a reviewed language). It polls while a translation is pending.
- **The public site** serves a language's translation where there is one. An untranslated article, in the tree and on its own, is served in the source language at the source's path.

## Import

`HelpImportService.importBundle` takes a bundle of collections → sections → articles (`@mocco/common/help-import`, `importBundleSchema`) and matches it to the site: collections by slug, sections by title, articles by their old path (`mocco_help_redirects`). New articles are created; known ones get an `import` revision only when their content hash changed; every new old path becomes a redirect; with `publish`, every imported article's draft is published. The console's **Import from Mintlify** reads a picked folder in the browser: `bundleFromMintlify` converts `docs.json` and the MDX (Steps → numbered list, Tip/Info/Note/Warning/Check → labelled quotes, Update → headings, other components dropped), the pages' images are uploaded first (`createImageUpload` → PUT → `completeImage`, public objects under the `helpcenter` storage policy: PNG, JPEG, WebP, GIF, 10 MB), and the bundle is sent one collection per request. On the public site, any other path is looked up as an old path and redirects (308) to its article.

## Operator API

The `help` tRPC router (`productProcedure(Products.helpcenter)`): `site`, `enable`, `updateSite`, `tree`, `createCollection`, `deleteCollection`, `createSection`, `deleteSection`, `createArticle`, `article`, `saveDraft`, `publish`, `unpublish`, `deleteArticle`, `history`, `restore`, `createImageUpload`, `completeImage`, `importBundle`, `translations`, `saveTranslation`, `retranslate`.
