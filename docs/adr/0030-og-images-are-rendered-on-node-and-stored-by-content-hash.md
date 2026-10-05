---
title: Open Graph images are rendered from templates on Node and stored by content hash
description: Mocco renders share images (og:image) itself — satori and resvg on the Node runtime, from templates kept as code plus a typed field list, with Pretendard for Korean — and serves each one from object storage under a URL that hashes everything it shows, so no cache, KakaoTalk's included, ever serves a stale card.
type: adr
status: draft
created: 2026-10-05
updated: 2026-10-05
confidence: medium
owner: andrea
decision_date: 2026-10-05
stakeholders: [andrea]
tags: [adr, seo, og-images, platform, help-center]
related:
  - ./0013-mocco-is-a-multi-product-platform.md
  - ./0015-public-sites-use-isr-on-the-pages-router.md
  - ./0025-every-product-surface-ships-mcp-tools.md
  - ../reference/seo.md
  - ../reference/storage.md
---

# ADR 0030 — Open Graph images are rendered from templates on Node and stored by content hash

## Context

Links to Mocco pages are shared in Slack, Discord, KakaoTalk and X. Since #364 every public page has Open Graph tags,
but the image is one static card for all of Mocco, and help center pages — the customer's site, not Mocco's — have
none. The surfaces still to come are the same kind of page: a status page whose card should show the current incident,
a changelog entry, a deep link with its own preview (#234). A card is worth most when it carries the page's own data,
and Mocco has that data; a hosted image service (Bannerbear, Placid) renders generic templates and knows nothing of an
incident or a release.

Three things constrain how:

- **Fonts.** Customers are Korean first. A Hangul font is several MB per weight; satori takes TTF, OTF or WOFF, not
  WOFF2, and draws a box for any glyph no supplied font covers. Vercel's Edge runtime caps a function bundle at about
  500 KB including fonts, which a Korean font alone exceeds.
- **Caches that never forget.** KakaoTalk keeps a scraped thumbnail with no way to purge it (its debugger clears page
  metadata only); LinkedIn keeps one for about a week; Slack and Discord key theirs on the exact URL. Changing the URL
  is the only refresh that works everywhere.
- **Abuse.** An endpoint that turns free text into an image on Mocco's domain is a free renderer and a phishing-card
  generator if anyone can call it with anything.

## Options

1. **Hosted service** (Bannerbear, Placid). No code to own, but per-image pricing, generic templates, a vendor in
   the path of every public page, and Korean typesetting at the vendor's mercy.
2. **`next/og` on the Edge runtime.** The Next.js default; ruled out by the bundle cap with a Korean font.
3. **satori + resvg on the Node runtime, rendered on request and cached by the CDN.** Works, but a CDN eviction means
   a re-render, and a cache that outlives a content change serves a stale card.
4. **satori + resvg on the Node runtime, stored in object storage under a content-hash URL** (chosen).
5. **Takumi** (a Rust renderer with WOFF2, CSS grid and better CJK shaping, behind a `next/og`-compatible API).
   Promising and faster, but younger; kept as the planned exit rather than the starting point.

## Decision

- **Renderer.** satori lays the template out as SVG and resvg rasterizes it to PNG, both on the Node runtime, behind a
  neutral surface: one leaf file imports them, as with every vendor (backend conventions). The route lives on the ext
  app (ADR 0011), which already runs on Node. Templates use only what satori and Takumi both support — flexbox, inline
  styles, no grid or `calc` — so changing renderer later doesn't mean rewriting them.
- **Fonts.** Pretendard (OFL) at 400 and 600 ships as TTF with the function and is read once per instance. Glyphs it
  doesn't cover (Hanja, kana, emoji) come from a fallback loader with an in-memory cache. Every template is tested with
  Latin, Hangul and emoji text so a missing glyph fails a test instead of shipping a box.
- **Templates are code plus a typed field list.** Each template is a component and a zod schema of its fields (title,
  description, brand, a status color…), borrowing the shape of shadcn-labs' ogimagecn (MIT, attributed where its
  templates are adapted). The schema is the API's validation, the console's form, and the MCP tool's input. Customers
  supply data and brand (name, logo, accent color); they never supply markup.
- **Storage by content hash.** The image URL is `/og/v1/<template>/<hash>.png`, where the hash covers the template's
  version, its field values and the brand. The first request renders it, stores the PNG under `pub/og/<hash>.png` in
  object storage, and serves it; later requests come from storage (or the CDN in front of it) without rendering. The
  response is `Cache-Control: public, max-age=31536000, immutable`. A content change makes a new hash and so a new URL in
  the page's `og:image`, which is what every unfurl cache needs to refresh. Only pages Mocco renders emit these URLs, so
  a hash nobody issued is a 404, not a render.
- **Format.** 1200×630 PNG under 1 MB, with `og:image:width`, `og:image:height` and `og:image:alt`; text stays inside a
  centered safe area because KakaoTalk crops toward 2:1.
- **Order.** Mocco's own surfaces first: the landing and `/docs` (#371), branded help center articles (#372), then the
  status page, the changelog and deep links as they ship, and a preview tool that fetches a URL as each crawler,
  KakaoTalk's included (#373). Rendering for customers' own sites — signed URLs with a per-project secret, `/v1/og`,
  the SDK and an MCP tool — is a later product (#374) and gets its own decision on signing and metering.

## Consequences

- Every public Mocco surface can carry a card built from its own data, with no customer setup.
- Images cost storage, not render time: each distinct card renders once. A page edited often leaves old images
  behind, and `storage.gc` today only clears stale pending uploads, so the renderer slice adds a sweep of `pub/og/`
  images no page has asked for in a while.
- The function carries a few MB of fonts. Cold starts parse them; a subset (KS X 1001 Hangul plus Latin) is the remedy
  if that shows up in latency.
- satori's CSS subset limits what a template can look like; that is the price of keeping Takumi as a drop-in exit.
- The renderer is a platform foundation, not a product: it is meant to make Mocco's surfaces look right when shared,
  and only later to be sold.
