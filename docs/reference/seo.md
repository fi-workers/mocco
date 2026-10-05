---
title: Search engines and crawlers
description: What Mocco serves to search engines, AI search and other crawlers on the app's host and on every help center's host — robots.txt (with a per-site switch for AI training crawlers), sitemap.xml, the metadata public pages carry, and llms.txt with each page's Markdown for agents.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, seo, help-center]
related:
  - ./help-center.md
code_refs:
  - packages/backend/src/transport/seo/files.ts
  - packages/backend/src/domain/helpcenter/site-url.ts
  - packages/frontend/src/pages/api/seo/sitemap.ts
---

# Search engines and crawlers

Part of the SEO epic (#362). Every host this deployment serves answers `/robots.txt` and `/sitemap.xml` from one place: `next.config.ts` rewrites both paths, on every host and before the help center rewrites, to `pages/api/seo/{robots,sitemap}.ts`. That route hands the request's `Host` to the backend (`@mocco/backend/seo/handler`), which decides whose files they are with `helpSiteForHost` — a domain in `HELP_CUSTOM_DOMAINS`, or `<slug>.<HELP_SITES_DOMAIN>`, is that help site; any other host is the app. Answers are cached by the CDN for an hour (`s-maxage=3600`, stale for a day).

## The app's host

- **robots.txt** allows every crawler — search and AI alike — and keeps them out of the console and auth screens (`/workspaces`, `/account`, `/auth/`, `/api/`).
- **sitemap.xml** lists the landing page and every customer guide (`/docs/<set>/<page>`), each guide with `lastmod` from its frontmatter `updated:` date. The guides are read from `docs/customer` at request time, so `next.config.ts` traces those files into the route (`outputFileTracingIncludes`).

URLs are absolute on `SERVICE_DOMAIN` (else `VERCEL_URL`), whatever host asked. Vercel preview deployments add `X-Robots-Tag: noindex` themselves.

## A help center's host

- **robots.txt** allows every crawler and disallows `/*/search` — results render in the browser, so the page is empty to a crawler. With the site's **Allow AI training crawlers** off (`mocco_help_sites.allow_ai_training`, default on; `help.setAiTraining`, audited as `help.site.ai_training.changed`), it adds a group for the training crawlers in `AI_TRAINING_CRAWLERS` — GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, meta-externalagent, Bytespider — that disallows everything. A crawler follows the most specific group naming it, so those leave while search agents (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot, Bingbot) keep the `*` group. A slug with no site is a 404.
- **sitemap.xml** lists each language's home and each published article in every language it is really served in: the source, plus each language that has a translation (another language redirects to the source's address, so it isn't listed). Each URL carries `xhtml:link` hreflang alternates for all its versions, itself included, and `x-default` (the source) — Google's reciprocal form. `lastmod` is the article's last publish for the source, and the translation's creation for a translated version. A slug with no site is a 404.

URLs are absolute on the site's canonical origin: its custom domain when `HELP_CUSTOM_DOMAINS` maps one, else its Mocco subdomain — so the subdomain copy of a site with a custom domain points crawlers at the custom domain.

One `<urlset>` holds the whole site; a sitemap index is only needed past 50,000 URLs.

## Page metadata

Every page starts out of search: `_app.tsx` sets `<meta name="robots" content="noindex">`, so the console and auth screens are never indexed by default. A public page opts in by rendering `SeoHead` (`components/seo-head.tsx`), which replaces that tag (every tag carries a `key`, so a page's value wins over `_app`'s) and adds the title, description, an absolute canonical URL, Open Graph (`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:locale`, `og:image` with width, height and alt) and a `summary_large_image` Twitter card. Absolute URLs use `NEXT_PUBLIC_SITE_HOST`, which `next.config.ts` fills from `SERVICE_DOMAIN` (else `VERCEL_URL`, a preview's own host) at build time.

The share image is `public/og/mocco.png` (1200×630) on every page until per-page images are generated (#368).

JSON-LD (`lib/seo.ts`, one `@graph` per page, `<` escaped so it can't end the script):

- **Landing:** Organization, WebSite, SoftwareApplication (`DeveloperApplication`).
- **A customer guide:** Organization, WebSite, a BreadcrumbList (Mocco → the guide set → the guide) and a TechArticle with `dateModified` from the guide's frontmatter `updated:`.

Not FAQPage or HowTo: Google restricted and retired those rich results in 2023.

## Help center pages

A help site's pages render `SeoHead` through `HelpSiteLayout` on the site's canonical origin (`helpSiteOriginFor`: its custom domain when `HELP_CUSTOM_DOMAINS` maps one, else `<slug>.<HELP_SITES_DOMAIN>`), so the copy on the Mocco subdomain of a site with a custom domain names the custom domain as canonical. Without `HELP_SITES_DOMAIN` they carry only a title and `robots`.

- **Language:** `_document.tsx` sets `<html lang>` from the page's `nav.locale`; Mocco's own pages stay `en`.
- **hreflang:** a home lists every language the site offers; an article lists the languages it is really served in (the source and each translated one — `HelpPublicReadService.article().locales`), each plus `x-default` (the source). Pages in a single language get none.
- **Description:** an article's is its first paragraphs as plain text, cut near 160 characters (`excerptOf`); a home's is its collection titles.
- **Open Graph:** `og:type` `article` or `website`, `og:site_name` the site's name, `og:locale` the page's language, and a `summary` Twitter card — no share image until branded ones are generated (#372), because Mocco's card isn't the customer's.
- **JSON-LD:** an article has a BreadcrumbList (home → article) and an Article with `inLanguage`, `datePublished` (last publish) and `dateModified` (the later of that and its translation), published by the site; a home has a WebSite with its languages.
- **Redirects:** an old slug redirects permanently (308) to the article's address; a language the article isn't translated into redirects temporarily (307) to the source, since a translation may come; the site root redirects temporarily to the source language.
- **robots:** `index, follow`, and `noindex, follow` on search results.

## Agents: llms.txt and Markdown

Coding agents and AI assistants read Markdown far more cheaply than HTML, so every page that has a source text also answers as Markdown (#366). `next.config.ts` rewrites these, on every host and ahead of the help center rewrites, to `pages/api/seo/agents.ts`, which hands the host to `agentFileFor` (`transport/seo/agents.ts`):

| URL | App host | Help center host |
|---|---|---|
| `/llms.txt` | Every customer guide set and its guides, each linked as `<page>.md` with its description ([llmstxt.org](https://llmstxt.org) form) | The site's collections and sections in its source language, each article linked as `.md` |
| `/<locale>/llms.txt` | 404 | The same in that language (untranslated articles at the source's address); 404 for a language the site doesn't offer |
| `/llms-full.txt`, `/<locale>/llms-full.txt` | Every guide's Markdown, each after a `Source:` line | Every article's Markdown in that language |
| `/docs/<set>/<page>.md` | The guide's Markdown, frontmatter dropped | 404 |
| `/<locale>/articles/<ref>.md` | 404 | The article's title and Markdown, as `article()` serves it |

The page's own URL asked for with `Accept: text/markdown` returns the same Markdown, and `next.config.ts` sends `Vary: Accept` on guide and article pages so caches keep the two apart. HTML pages point at their Markdown with `<link rel="alternate" type="text/markdown">` (`SeoHead`'s `markdownUrl`; the `/docs` index points at `/llms.txt`). Relative links in a guide's Markdown (`./other.md`, `./images/x.png`) resolve against its `.md` URL to the same pages and images. Answers are cached by the CDN for an hour. Only published articles are reachable: everything goes through the public read (`HelpPublicReadService.forAgents` and `article`).
