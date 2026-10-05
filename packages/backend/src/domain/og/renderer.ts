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

export type OgRenderer = (element: OgElement, size: { width: number; height: number }) => Promise<Uint8Array>;

/**
 * `onMissingGlyphs` hears each run of text no supplied font covers (it renders as boxes):
 * tests assert it stays silent for Latin and Hangul. Emoji, Hanja and kana are not covered
 * yet; a fallback font loader is the follow-up (ADR 0030).
 */
export function createOgRenderer(
  loadFonts: () => Promise<readonly OgFont[]>,
  opts: { onMissingGlyphs?: (segment: string) => void } = {},
): OgRenderer {
  // Read once, on the first render, and shared by every render after it.
  let fonts: Promise<{ name: string; data: ArrayBuffer; weight: 400 | 600; style: 'normal' }[]> | undefined;
  return async (element, size) => {
    fonts ??= (async () => {
      const loaded = await loadFonts();
      return loaded.map(font => ({
        name: font.name,
        // satori takes an ArrayBuffer; copy so a pooled Buffer's slack bytes don't leak in.
        data: new Uint8Array(font.data).buffer,
        weight: font.weight,
        style: 'normal' as const,
      }));
    })();
    const satoriFonts = await fonts;
    // satori reads the React element shape; ours is that shape without React's types.
    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: size.width,
      height: size.height,
      fonts: satoriFonts,
      loadAdditionalAsset: async (_languageCode, segment) => {
        opts.onMissingGlyphs?.(segment);
        return await Promise.resolve([]);
      },
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size.width } }).render().asPng();
    return new Uint8Array(png);
  };
}
