// The vendor leaf for OG images (ADR 0030): the only file that imports satori (layout to
// SVG) and resvg (SVG to PNG). Everything else hands it an element tree and fonts and gets
// PNG bytes back, so the renderer can change (Takumi) without touching templates.
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

import type { OgElement } from '@backend/domain/og/element';

export interface OgFont {
  name: string;
  data: Uint8Array;
  weight: 400 | 600;
}

export interface OgCjkFallback {
  fonts: readonly OgFont[];
  /** Whether the fonts have a glyph for this character. */
  covers: (char: string) => boolean;
}

/** Where glyphs the main fonts lack come from (`domain/og/fallback.ts`). */
export interface OgFallbacks {
  /** An SVG for one emoji grapheme, or undefined when there is none (or it can't be read). */
  emoji: (grapheme: string) => Promise<string | undefined>;
  /** The Hanja and kana fonts, or undefined when they can't be read. */
  cjk: () => Promise<OgCjkFallback | undefined>;
}

export type OgRenderer = (element: OgElement, size: { width: number; height: number }) => Promise<Uint8Array>;

interface SatoriFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: 'normal';
}

// satori takes an ArrayBuffer; copy so a pooled Buffer's slack bytes don't leak in. satori
// caches a parsed font by its ArrayBuffer, so each font is converted once and then reused.
const toSatori = (loaded: readonly OgFont[]): SatoriFont[] =>
  loaded.map(font => ({
    name: font.name,
    data: new Uint8Array(font.data).buffer,
    weight: font.weight,
    style: 'normal',
  }));

/** The scripts the CJK fallback is for; satori tags their runs ja-JP, zh-* or both. */
const HAN_OR_KANA = /\p{scx=Han}|\p{scx=Hira}|\p{scx=Kana}/u;

/**
 * satori asks `loadAdditionalAsset` for each run of text no supplied font covers: an emoji
 * grapheme gets its SVG as an image, Hanja and kana get the CJK fallback fonts (converted
 * once and kept for the renderer's life). `onMissingGlyphs` hears whatever is still uncovered after
 * that, which renders as boxes: tests assert it stays silent for Latin, Hangul, Hanja, kana
 * and emoji.
 */
export function createOgRenderer(
  loadFonts: () => Promise<readonly OgFont[]>,
  opts: { fallbacks?: OgFallbacks; onMissingGlyphs?: (segment: string) => void } = {},
): OgRenderer {
  const { fallbacks, onMissingGlyphs } = opts;
  // Read once, on the first render, and shared by every render after it.
  let fonts: Promise<SatoriFont[]> | undefined;
  let cjk: Promise<{ fonts: SatoriFont[]; covers: (char: string) => boolean } | undefined> | undefined;

  const emojiImage = async (grapheme: string): Promise<string | undefined> => {
    const svg = await fallbacks?.emoji(grapheme);
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Buffer is the codec on this Node
    return svg === undefined ? undefined : `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  };

  const cjkFonts = async (segment: string): Promise<SatoriFont[]> => {
    if (fallbacks === undefined || !HAN_OR_KANA.test(segment)) {
      onMissingGlyphs?.(segment);
      return [];
    }
    cjk ??= (async () => {
      const loaded = await fallbacks.cjk();
      return loaded && { fonts: toSatori(loaded.fonts), covers: loaded.covers };
    })();
    const loaded = await cjk;
    if (loaded === undefined) {
      // The read failed and was logged; the next render tries again.
      cjk = undefined;
    }
    const uncovered = [...segment].filter(char => loaded?.covers(char) !== true).join('');
    if (uncovered !== '') {
      onMissingGlyphs?.(uncovered);
    }
    return loaded?.fonts ?? [];
  };

  return async (element, size) => {
    fonts ??= (async () => toSatori(await loadFonts()))();
    const satoriFonts = await fonts;
    // satori reads the React element shape; ours is that shape without React's types.
    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: size.width,
      height: size.height,
      fonts: satoriFonts,
      loadAdditionalAsset: async (languageCode, segment) => {
        if (languageCode !== 'emoji') {
          return await cjkFonts(segment);
        }
        const image = await emojiImage(segment);
        if (image === undefined) {
          onMissingGlyphs?.(segment);
          return [];
        }
        return image;
      },
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size.width } }).render().asPng();
    return new Uint8Array(png);
  };
}
