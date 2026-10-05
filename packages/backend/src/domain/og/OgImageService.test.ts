import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cmapCodePoints, codePoints, createOgFallbacks } from '@backend/domain/og/fallback';
import { loadOgFonts, ogAssetsDir } from '@backend/domain/og/instance';
import { OgImageService } from '@backend/domain/og/OgImageService';
import { createOgRenderer } from '@backend/domain/og/renderer';
import { OG_HEIGHT, OG_WIDTH, OgTemplates } from '@backend/domain/og/templates';

const assets = ogAssetsDir(process.cwd());
const loadFonts = async () => await loadOgFonts(assets);

/** PNG width and height from the IHDR chunk (bytes 16–23). */
const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const setUp = (fallbacks = createOgFallbacks(assets)) => {
  const stored = new Map<string, Uint8Array>();
  const missing: string[] = [];
  let renders = 0;
  const render = createOgRenderer(loadFonts, {
    fallbacks,
    onMissingGlyphs: segment => {
      missing.push(segment);
    },
  });
  const og = new OgImageService({
    secret: 'test-secret',
    render: async (element, size) => {
      renders += 1;
      return await render(element, size);
    },
    store: () => ({
      get: async key => await Promise.resolve((stored.get(key) as Uint8Array<ArrayBuffer> | undefined) ?? null),
      put: async (key, body) => {
        stored.set(key, body);
        return await Promise.resolve({ etag: 'e' });
      },
    }),
  });
  return { og, stored, missing, renders: () => renders };
};

/** Split an issued path into what the route hands `image`. */
const parts = (issued: string) => {
  const url = new URL(issued, 'https://x.test');
  const segments = url.pathname.split('/');
  return { template: segments[3] ?? '', file: segments[4] ?? '', data: url.searchParams.get('d') ?? undefined };
};

describe('OgImageService', () => {
  it('renders an issued card once as a 1200x630 PNG, then serves it from storage', async () => {
    const { og, stored, renders } = setUp();
    const issued = og.issue('article', {
      brand: { name: 'Mocco', accent: '#2563eb' },
      eyebrow: 'Feature flags',
      title: 'Feature flags quickstart',
      description: 'Evaluate flags locally with OpenFeature.',
    });
    const { template, file, data } = parts(issued);

    const first = await og.image(template, file, data);
    const second = await og.image(template, file, data);

    expect(issued).toMatch(/^\/og\/v1\/article\/[\w-]{32}\.png\?d=[\w-]+$/u);
    expect(first === undefined ? undefined : pngSize(first)).toEqual({ width: OG_WIDTH, height: OG_HEIGHT });
    expect(second).toEqual(first);
    expect(renders()).toBe(1);
    expect([stored.size, stored.has(`pub/og/article/${file}`)]).toEqual([1, true]);
  });

  it('refuses a forged signature, changed data, another template and junk', async () => {
    const { og, renders } = setUp();
    const { template, file, data } = parts(og.issue('simple', { brand: { name: 'Mocco' }, title: 'Hello' }));
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Buffer is the codec on this Node
    const other = Buffer.from(JSON.stringify({ brand: { name: 'Evil' }, title: 'Log in here' })).toString('base64url');

    const results = await Promise.all([
      og.image(template, `${'a'.repeat(32)}.png`, data),
      og.image(template, file, other),
      og.image('article', file, data),
      og.image('nope', file, data),
      og.image(template, file, undefined),
      og.image(template, 'x.png', data),
    ]);

    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(renders()).toBe(0);
  });

  it('gives a card a new URL when its fields or its template version change', () => {
    const { og } = setUp();
    const fields = { brand: { name: 'Mocco' }, title: 'Hello' };

    expect(og.issue('simple', fields)).toBe(og.issue('simple', fields));
    expect(og.issue('simple', { ...fields, title: 'Hello!' })).not.toBe(og.issue('simple', fields));
    expect(OgTemplates.simple.version).toBeGreaterThan(0);
  });

  it('has a glyph for every Latin, Hangul, Hanja, kana and emoji character a card shows', async () => {
    const { og, missing } = setUp();
    const { template, file, data } = parts(
      og.issue('article', {
        brand: { name: '쇼유어타임 ShowYourTime 🎬' },
        eyebrow: '시작하기 · 入門 · はじめに',
        title: 'iOS 위젯으로 홈 화면에서 바로 촬영하기 📸 — 똠얌꿍 쌰 뷁 · 大韓民國 學校',
        description: 'Pricing: ₩9,900 · 50% off “today” (1–3 days). 東京のカフェ ☕️ 👩‍💻 🇰🇷 ❤️',
      }),
    );

    const png = await og.image(template, file, data);

    expect(png).toBeDefined();
    expect(missing).toEqual([]);
  });

  it('reports what no font or emoji covers, and renders it as boxes', async () => {
    const { og, missing } = setUp();
    // Thai has no font here, and U+20000 (CJK extension B) is outside the Hanja subset.
    const { template, file, data } = parts(og.issue('simple', { brand: { name: 'Mocco' }, title: 'สวัสดี 𠀀 漢' }));

    const png = await og.image(template, file, data);

    expect(png).toBeDefined();
    expect(missing.join('')).toContain('ส');
    expect(missing.join('')).toContain('𠀀');
    expect(missing.join('')).not.toContain('漢');
  });

  it('still renders, with boxes, when the fallback assets cannot be read', async () => {
    const { og, missing } = setUp(createOgFallbacks('/nonexistent'));
    const { template, file, data } = parts(og.issue('simple', { brand: { name: 'Mocco' }, title: '東京 🎬' }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const png = await og.image(template, file, data);

    expect(png).toBeDefined();
    expect(missing.join('')).toContain('東京');
    expect(missing).toContain('🎬');
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('maps the CJK subset to kana and the KS X 1001 and JIS X 0208 Hanja', async () => {
    const font = await readFile(path.join(assets, 'fonts', 'NotoSansCJKkr-Regular.otf'));
    const covered = cmapCodePoints(font);
    const isCovered = (text: string) => codePoints(text).every(cp => covered.has(cp));

    expect(isCovered('あいうえおアイウエオ漢字學校大韓民國東京')).toBe(true);
    expect(covered.has(0x2_00_00)).toBe(false);
    expect(covered.size).toBeGreaterThan(7000);
  });
});
