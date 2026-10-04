---
title: Search engines and crawlers
description: What Mocco serves to search engines, AI search and other crawlers on the app's host and on every help center's host — robots.txt and sitemap.xml so far.
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

- **robots.txt** allows every crawler and disallows `/*/search` — results render in the browser, so the page is empty to a crawler.
- **sitemap.xml** lists each language's home and each published article in every language it is really served in: the source, plus each language that has a translation (another language redirects to the source's address, so it isn't listed). Each URL carries `xhtml:link` hreflang alternates for all its versions, itself included, and `x-default` (the source) — Google's reciprocal form. `lastmod` is the article's last publish for the source, and the translation's creation for a translated version. A slug with no site is a 404.

URLs are absolute on the site's canonical origin: its custom domain when `HELP_CUSTOM_DOMAINS` maps one, else its Mocco subdomain — so the subdomain copy of a site with a custom domain points crawlers at the custom domain.

One `<urlset>` holds the whole site; a sitemap index is only needed past 50,000 URLs.
