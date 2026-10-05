---
title: OG images
description: How Mocco renders Open Graph share images — templates, signed and content-addressed URLs, the render-once cache in object storage, fonts, and the route every host serves.
type: reference
status: active
created: 2026-10-05
updated: 2026-10-06
confidence: high
owner: andrea
tags: [reference, og-images, seo, platform]
related:
  - ../adr/0030-og-images-are-rendered-on-node-and-stored-by-content-hash.md
  - ./seo.md
  - ./storage.md
code_refs:
  - packages/backend/src/domain/og/OgImageService.ts
  - packages/backend/src/domain/og/templates.ts
  - packages/backend/src/domain/og/renderer.ts
  - packages/backend/src/domain/og/fallback.ts
  - scripts/og-assets/build-cjk-fonts.py
  - scripts/og-assets/pack-twemoji.mjs
  - packages/backend/src/transport/ext/og.ts
---

# OG images

The renderer foundation of the OG images epic (#368, slice #370), per [ADR 0030](../adr/0030-og-images-are-rendered-on-node-and-stored-by-content-hash.md). Every customer guide and the `/docs` index carry their own card (#371); the landing keeps its designed static card (`public/og/mocco.png`). A help center's articles and homes carry cards under the site's name (#372): an article's shows its collection, title and opening text, a home's the site's name and its collections, issued when ISR builds the page and served from the help center's own domain.

## Issuing an image

Server code asks `getOgImages().issue(template, fields)` (`domain/og/instance.ts`) for a path:

```
/og/v1/<template>/<signature>.png?d=<data>
```

`data` is the fields, validated by the template's schema, as base64url JSON. `signature` is the first 32 base64url characters of HMAC-SHA256 over `<template>@<version>\n<data>`, keyed by a secret derived from `AUTH_SECRET` (`HMAC(AUTH_SECRET, "mocco-og-images")`). Without `AUTH_SECRET` there is no service and the route answers 404. The path is relative: a page prefixes its own origin, so a help center's card is served from the help center's domain.

Mocco's pages issue their cards in `getStaticProps` through `lib/og-card.ts` (`moccoArticleCard`, `moccoSimpleCard`; texts are cut at a word to the templates’ limits): a guide gets the `article` template (its set, title and description), the `/docs` index the `simple` one, and `SeoHead`'s `image` puts the path on the page's origin in `og:image` and `twitter:image`. Issuing reads only the secret — the store is a getter used when an image is served — so a build needs `AUTH_SECRET` and nothing else; without it they return null and the page keeps Mocco's static card.

## Serving it

`next.config.ts` rewrites `/og/v1/*` on every host to the ext app's `GET /api/ext/og/v1/:template/:file` (`transport/ext/og.ts`), which calls `OgImageService.image`:

1. An unknown template, a malformed or wrong signature (compared in constant time), or data over 2,048 characters is a 404. Nothing is rendered for a URL Mocco didn't issue.
2. With object storage configured, `pub/og/<template>/<signature>.png` is returned when it exists.
3. Otherwise the fields are decoded and validated again, rendered, stored at that key (public, `Cache-Control: public, max-age=31536000, immutable`) and returned.

The response is `image/png` with the same immutable `Cache-Control`. Without a store (local dev without one) every request renders.

A change to the fields, or to the template's `version`, is a new signature and so a new URL — the refresh every unfurl cache needs, KakaoTalk's included, which never purges a thumbnail it has scraped. Bump a template's `version` whenever its look changes.

## Templates

`domain/og/templates.ts` holds each template's `version`, a zod schema of its `fields` and a `build` to an element tree (`domain/og/element.ts`: `box` and `text`, flexbox and inline styles only, so satori and Takumi both lay it out). Cards are 1200×630 with text inside a centered safe area for Kakao's 2:1 crop; text breaks between words (`word-break: keep-all`), never inside a Korean word.

| Template | Fields | For |
|---|---|---|
| `simple` | `brand` (`name`, optional `accent` `#rrggbb`), `title`, optional `subtitle` | Landing and product pages |
| `article` | `brand`, optional `eyebrow` (the set or collection), `title`, optional `description` | Guides and help articles |

## Rendering

`domain/og/renderer.ts` is the only file that imports satori (layout to SVG) and resvg (SVG to PNG). It runs on the Node runtime; `next.config.ts` keeps both out of the bundle (`serverExternalPackages`: resvg is a native addon and satori loads its wasm from its package) and traces the fonts into the ext route (`outputFileTracingIncludes`). Fonts are Pretendard 400 and 600 (OFL, `domain/og/fonts/`), subset to Latin, Latin-1, general punctuation, CJK punctuation, Hangul jamo and every Hangul syllable, read once on the first render.

### Fallbacks: emoji, Hanja and kana

satori hands the renderer each run of text Pretendard doesn't cover (`loadAdditionalAsset`), and `domain/og/fallback.ts` answers it from assets bundled beside the fonts:

| Run | Drawn with | File |
|---|---|---|
| An emoji grapheme (ZWJ sequences, flags and skin tones included) | Twemoji 17.0.3's SVG, embedded as an image | `domain/og/emoji/twemoji.json.br`: all 4,009 SVGs as one brotli JSON, about 0.95 MB |
| Kana, CJK punctuation, full-width forms, Hanja | Noto Sans CJK KR 2.004 at 400 and 600 | `domain/og/fonts/NotoSansCJKkr-{Regular,SemiBold}.otf`, about 4.1 MB each |

The CJK fonts keep kana and the 7,159 ideographs that KS X 1001 (Korean Hanja) and JIS X 0208 (Japanese kanji) encode, with Korean glyph forms. Each asset is read on the first card that needs it and kept in memory for the instance's life; satori caches the parsed fonts. Anything still uncovered (another script, a rarer ideograph, an emoji Twemoji lacks) renders as a box and reaches `onMissingGlyphs`. If an asset can't be read, the card still renders with boxes, the error is logged with an `[og]` prefix, and the next card tries again. Keycap emoji (`#️⃣`, `1️⃣`) show their plain character: satori draws the base from Pretendard and never asks for the sequence.

The assets are bundled rather than fetched because a card is rendered once and then served from storage forever under its URL: a fetch that failed, or a CDN that changed an image, would stay in that card for good. Bundling also keeps self-hosted and offline renders, and the tests, identical. It costs about 9 MB more in the ext function, well within a Node function's limit; Edge was already ruled out (ADR 0030).

The tests render Latin, Hangul, Hanja, kana and emoji and fail if any glyph is missing, check that uncovered text is reported, and check that a card still renders when the assets are missing.

Licenses sit beside the files: `fonts/OFL.txt` (Pretendard), `fonts/NotoSansCJK-OFL.txt` (Noto Sans CJK, OFL 1.1) and `emoji/LICENSE-GRAPHICS.txt` (Twemoji graphics, CC-BY 4.0, with the attribution). To rebuild them from upstream, `scripts/og-assets/build-cjk-fonts.py` (fontTools) instances and subsets `NotoSansCJKkr-VF.otf` from noto-cjk's `Sans2.004` tag, and `scripts/og-assets/pack-twemoji.mjs` packs `assets/svg` from Twemoji's `v17.0.3` tag. Bump a template's `version` if a rebuild changes how existing cards look.
