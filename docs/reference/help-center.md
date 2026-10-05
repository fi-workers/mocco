---
title: Help center
description: How Mocco stores a project's help center — a public slug and languages, collections → sections → articles, append-only revisions with publish and restore — and the operator and public-read services over them.
type: reference
status: active
created: 2026-10-02
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, help-center, support]
related:
  - ../specs/2026-09-24-help-center-design.md
  - ./project.md
code_refs:
  - packages/backend/src/domain/helpcenter/HelpAuthoringService.ts
  - packages/backend/src/domain/helpcenter/HelpImageService.ts
  - packages/backend/src/domain/helpcenter/HelpPublicReadService.ts
  - packages/backend/src/domain/helpcenter/HelpFeedbackService.ts
  - packages/common/src/help.ts
  - packages/common/src/help-v1.ts
  - packages/backend/src/transport/ext/v1/help.ts
---

# Help center

The [help center design](../specs/2026-09-24-help-center-design.md) (#96) so far: the data model, the services to write, publish and read a help center, the public site, the console editor, import, translation and search. Custom domains are served by host (`HELP_CUSTOM_DOMAINS`); verifying them in the console comes later.

## Sites

A project has at most one help site (`mocco_help_sites`, migration 0042): a public `slug` (unique across Mocco; the site will be served at `<slug>.help.<domain>` until a custom domain is bound), a `source_locale` the team writes in, and `locales`, the languages it is translated into (never the source). `help.enable` and `help.updateSite` are audited as `help.site.enabled` / `help.site.changed`; a taken slug is a CONFLICT. `allow_ai_training` (migration 0060, default true) decides whether its robots.txt lets AI training crawlers in; `help.setAiTraining` changes it, audited as `help.site.ai_training.changed` ([Search engines and crawlers](./seo.md)).

## Collections, sections, articles

Collections (`mocco_help_collections`, with a slug unique in the project) hold sections (`mocco_help_sections`), which hold articles (`mocco_help_articles`). New nodes go last; deleting a collection or section deletes what it holds.

An article has a stable `short_id` (6 characters, unique in the project) and a cosmetic `slug`. Its public path is `/{locale}/articles/{short_id}-{slug}`; a stale slug resolves to the same article and the reader gets the canonical path back to redirect to.

## Revisions and publishing

Text lives in `mocco_help_revisions`: locale, title, Markdown body, a `content_hash` (sha256 of the normalized title and body; translations compare against it) and a `kind` (`source_edit`, `restore`, `import`). The article points at its `draft_revision_id` and its `published_revision_id`.

- **Save** (`saveDraft`) makes the text the draft. The public site keeps the published one. Text equal to the draft's writes nothing. Within an editing session it rewrites the draft revision instead of adding one: the draft is a `source_edit` by the same person, not the published revision, and started less than `EDIT_SESSION_MS` (10 minutes) ago. Anything else (a published, restored or imported draft, another author, an older session) gets a new revision, so a revision is never changed once it is published, restored or superseded. The service sets `created_at` from its own clock, which the session check compares against.
- **Publish** makes the draft the published revision (`help.article.published`, audited). Publishing with no draft is a CONFLICT.
- **Unpublish** takes the article off the public site; text and history stay (`help.article.unpublished`).
- **Restore** copies an old revision into a new `restore` revision that becomes the draft, so history stays append-only.
- **Delete** removes the article and its revisions (`help.article.deleted`).

## Public read

`HelpPublicReadService` reads by the site's slug, with no session: the site, the published tree in a language, a published article by its URL ref, and old paths in `mocco_help_redirects` (an imported site's URLs). A language the site doesn't have is served in the source language. Drafts never appear.

## The /v1 read API

Apps read a project's help center through `/v1/help` with a key holding `help:read` (publishable keys allowed, so the origin check and the per-key rate limit of the [public API](./public-api.md) apply): `GET /v1/help/site` (name, languages and the published collections → sections → articles), `GET /v1/help/collections/{slug}`, `GET /v1/help/articles/{id}` and `GET /v1/help/search`. The key names the project (`siteInProject`, `articleInProject`, `searchInProject` on `HelpPublicReadService`), so a key never reads another project's help center. An article's `id` is its short id; the slug alone isn't unique in a project, so a ref always carries the short id. The language is negotiated as the public site does it: a device's tag counts by its language, an offered language is served where translated and the source elsewhere, and the answer's `locale` says which. Answers are narrowed through the schemas in `@mocco/common/help-v1` and carry a weak ETag (`304` on a match). The SDK wraps them as `HelpClient` (`search`, `getSite`, `getCollection`, `getArticle`, and `sendFeedback` for [Was this helpful?](#was-this-helpful); [SDK packages](./sdk.md)).

The messenger can use the same search in-process (`domain/messenger/help-suggestions.test.ts` is the contract): what a contact's conversation knows, its workspace, project and text, is all `searchInProject` takes.

## Was this helpful?

Readers answer yes or no under a published article (`HelpFeedbackService`, `mocco_help_feedback`, migration 0065): from an app with `POST /v1/help/articles/{id}/feedback` (`help:read`; the key names the project) or from the public site's widget through `POST /api/help/feedback` (by the site's slug, no key), with the same rules. Only published articles take answers; a draft, an unpublished article or another project's is not found. The answer stores the language the reader read in (the asked one when the site offers it, else the source), an optional comment (500 characters, seen only in the console) and a visitor key.

One answer per visitor, article and UTC day is counted (a unique index on article, visitor and day); answering again that day replaces the earlier answer (`counted: false`). The visitor key is a keyed hash, so no personal data is kept:

- A client sends an opaque `visitorId` it keeps: the SDK takes one from the app (an install id) or makes a random one per client; the site's widget keeps a random id in `localStorage`. Mocco stores `HMAC(secret, project + id)`, truncated, which can't be reversed or linked across projects.
- Without one (storage off, a bare HTTP call), the network address and user agent stand in, hashed together with the day, so the same reader is one visitor for that day only.
- The key is derived from `AUTH_SECRET` for this purpose alone. Raw addresses, user agents and client ids are never stored.

Answers are limited to 30 a minute per client address on both surfaces (an app's users share its key), on top of the key's own limit. They aren't audited: a reader's vote isn't a governance action. The article editor's **Was this helpful?** section (`help.helpfulness`) shows the last 30 days' share of yes, the yes and no counts and the five newest comments; it appears once the article is published.

## Public site

With `HELP_SITES_DOMAIN` set, `https://<slug>.<domain>/` serves the site ([ADR 0015](../adr/0015-public-sites-use-isr-on-the-pages-router.md)): `/` redirects to the source language, `/{locale}` lists the published collections, `/{locale}/articles/{shortId}-{slug}` shows an article (a stale slug or a missing language redirects to the canonical path), and an unknown site is a 404. Pages are generated on first request and regenerated at most every 60 seconds. With the job tick's secret set (`CRON_SECRET` or `JOBS_TICK_SECRET`), a publish, unpublish, delete or new translation also rebuilds the pages it touched at once: the backend (`HelpRevalidation`, `HttpHelpRevalidator`) POSTs their internal paths to `/api/help/revalidate` on its own origin with that secret as a bearer, and the route calls `res.revalidate` for the site's home and the article, in every language. Other pages, whose article list may show a new title, catch up within the minute; a failed rebuild is logged and left to the 60-second refresh. Article Markdown renders through the same tree as the customer guides; links may be `http(s)`, `mailto`, site paths or anchors, and images must be `https`.

Pages carry a canonical URL on the site's own origin, hreflang alternates for the languages each page is served in, `<html lang>`, Open Graph and Article JSON-LD. Each site also answers `/robots.txt` and `/sitemap.xml` (every language version of each published article, with hreflang alternates) on its canonical origin — see [Search engines and crawlers](./seo.md). In production a public change is also submitted to IndexNow (`help.indexnow`).

## Custom domains

`HELP_CUSTOM_DOMAINS` maps a customer's domain to a site slug (`help.example.com=example`); `next.config.ts` adds a host rewrite per pair, alongside the `<slug>.<HELP_SITES_DOMAIN>` one, so the site's pages, redirects and old paths all work on that host. It is set per deployment for now: a domain needs adding to the Vercel project (and its DNS pointing there) anyway. Verifying domains from the console, through the Vercel Domains API, comes later.

## Console

The project's **Help center** tab (shown once the product is on) sets the site up (address, source language, offered languages), lists collections → sections → articles with their state (Draft, Published, Unpublished changes), and adds each level. The article editor shows the Markdown beside a live preview rendered by the same tree as the public site (`lib/help-markdown.ts`), with Publish (which saves unsaved text first), Unpublish, Delete and the revision history with Restore ([customer guide](../customer/help/help-center.md)). The draft autosaves 2.5 seconds after the last keystroke (never while one save is in flight, and a failed save waits for new text or Try again), shown as Saving… / All changes saved / Couldn't save; leaving with unsaved text asks first. A restore remounts the editor with the restored text; a save doesn't, so typing during a save isn't interrupted.

## Images

Article images are public objects of the project's help center in [object storage](./storage.md) (`HelpImageService`): `createImageUpload` checks the help center's storage policy (PNG, JPEG, WebP, GIF; 10 MB, also enforced by the input schema) and the workspace quota and returns a presigned PUT; `completeImage` completes only an upload reserved by that project's help center (`completeUpload` with an owner: project, product and visibility; anything else is not found), reads the bytes and deletes them if their signature isn't the declared image type (`HelpImageNotAnImageError`), and returns the stable public URL. An image the project already stored (same sha256) comes back as its URL without an upload. The editor uploads pasted, dropped and picked images this way and inserts `![name](public URL)` where the cursor was (a placeholder holds the place during the upload); the Mintlify import uses the same calls. Markdown refers to images by that URL, so the preview and the public site render them with no lookup, and `mocco_objects` records who owns each one. There is no per-article image table: an image removed from every article stays stored until a cleanup for unreferenced images lands.

## Translation

Each article has a translation per offered language in `mocco_help_translations` (migration 0043): a state (`pending`, `auto` for machine text, `reviewed` for a person's text, `failed`), the current text as a revision in that language (`machine` or `human_edit`), and the content hash of the published source it was made from. A translation is **stale** when that hash differs from the current published source; staleness is derived, not stored.

- **On publish**, `HelpTranslationService.onPublished` queues a `help.translate` job per offered language, except languages with a reviewed translation (deduped per article and language).
- **The job** sends the published title and Markdown to the `Translator` port. The production driver is `AiGatewayTranslator`, an AI Gateway chat completion asking for `{title, body}` JSON; it exists only with `AI_GATEWAY_API_KEY`. The answer must keep the source's structure (`translate/validate.ts`: the same heading levels, identical code fences, the same link and image targets), or it is refused and the translation is `failed` with the reason. An outage or rate limit throws, so the job retries. A translation already made from the current source is not redone.
- **A person's text** (`help.saveTranslation`) is stored as `reviewed` and is never overwritten by the machine; when the source changes it shows as stale. `help.retranslate` asks the machine again for one language, replacing a reviewed text too.
- **The console**: the article editor's **Translations** section lists each offered language with its state (Machine translated, Reviewed, Source changed, Failed with the reason, Not translated), an editor with a live preview to write or fix one (saved as reviewed), and **Translate again** (confirmed first on a reviewed language). It polls while a translation is pending.
- **Collection and section titles** are translated along with the first article translated under them into a language, and again when renamed (`mocco_help_node_translations`, migration 0044, keyed by the source title they were made from). A failed title keeps the source title.
- **The public site** serves a language's translation where there is one. An untranslated article, in the tree and on its own, is served in the source language at the source's path.

## Import

`HelpImportService.importBundle` takes a bundle of collections → sections → articles (`@mocco/common/help-import`, `importBundleSchema`) and matches it to the site: collections by slug, sections by title, articles by their old path (`mocco_help_redirects`). New articles are created; known ones get an `import` revision only when their content hash changed; every new old path becomes a redirect; with `publish`, every imported article's draft is published. The console's **Import from Mintlify** reads a picked folder in the browser: `bundleFromMintlify` converts `docs.json` and the MDX (Steps → numbered list, Tip/Info/Note/Warning/Check → labelled quotes, Update → headings, other components dropped), the pages' images are uploaded first (`createImageUpload` → PUT → `completeImage`, public objects under the `helpcenter` storage policy: PNG, JPEG, WebP, GIF, 10 MB), and the bundle is sent one collection per request. On the public site, any other path is looked up as an old path and redirects (308) to its article.

## Search

`searchArticles` (`domain/helpcenter/search.ts`) runs in memory over a site's published texts, in the reader's locale where translated and the source elsewhere. Matching is case-insensitive substring per term, so any script works without a tokenizer. Two modes:

- `all` (default, the public site's search box): every term (up to 6) must appear in the title or the text.
- `any` (free text, such as an inquiry being written in an app): one term is enough. Terms shorter than two letters are skipped, up to 24 are used, trailing punctuation is dropped, and a term of three or more letters ending in Hangul also matches without its last letter, so a Korean word with a particle ("위젯이") finds "위젯".

Ranking: matched terms ×100, title matches ×10, text matches ×1. Each hit has a 140-character plain-text snippet around the first match in the text. Served at `/api/help/search` (public site, frontend) and `GET /v1/help/search` (`help:read`, publishable keys allowed; `q` up to 500 characters, `match=all|any`, `limit` up to 20); the SDK wraps the latter as `HelpClient.search` and `useHelpSearch` (`@mocco/react-native/messenger`).

## MCP tools

`transport/mcp/tools/help.ts` ([ADR 0025](../adr/0025-every-product-surface-ships-mcp-tools.md)) reads the same published content as `/v1/help`, behind `ProjectScope` with `Products.helpcenter` (membership, the product on, the project in that workspace, as `productProcedure` checks them). `mocco_help_articles_search` runs `searchInProject` with a query (`match` all or any, up to 20 hits; detailed adds the collection, section and snippet), or lists the published tree in order without one (paged with `after`). `mocco_help_articles_get` reads `articleInProject` by the short id or `{id}-{slug}`: concise is the first 600 characters of the Markdown (`isTruncated`), detailed the whole text. Both carry `helpfulness`, the console's read (`HelpFeedbackService.helpfulness`) of [Was this helpful?](#was-this-helpful) over the last 30 days: `helpful`, `notHelpful` and `share` (of yes, two decimals; `null` without answers); detailed adds the five newest comments with their answer, language and time. Visitor hashes never leave the service. Drafts and unpublished articles read like ids that were never used, and another workspace's project like one that does not exist. Both are read-only; writing, publishing and translating stay in the console.

## Operator API

The `help` tRPC router (`productProcedure(Products.helpcenter)`): `site`, `enable`, `updateSite`, `tree`, `createCollection`, `deleteCollection`, `createSection`, `deleteSection`, `createArticle`, `article`, `saveDraft`, `publish`, `unpublish`, `deleteArticle`, `history`, `restore`, `createImageUpload`, `completeImage`, `importBundle`, `translations`, `saveTranslation`, `retranslate`, `helpfulness`.
