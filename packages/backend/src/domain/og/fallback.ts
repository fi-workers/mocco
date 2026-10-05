// What a card draws when Pretendard has no glyph (ADR 0030): Twemoji for emoji and a
// Noto Sans CJK KR subset for Hanja and kana. Both are bundled beside the renderer, so a
// card renders the same offline, in tests and on every deploy; a card is rendered once and
// kept forever, so a fetched asset that failed once would leave its boxes in it for good.
// Each asset is read on the first card that needs it and kept in memory for the instance's
// life. A failed read is logged and leaves boxes in that card; the next card tries again.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliDecompress } from 'node:zlib';

import { z } from 'zod';

import type { OgCjkFallback, OgFallbacks } from '@backend/domain/og/renderer';

const unbrotli = promisify(brotliDecompress);
const ZWJ = '\u{200D}';
const VS16 = /\u{FE0F}/gu;
/** scripts/og-assets/pack-twemoji.mjs writes `{ "<code points>": "<svg …>" }`. */
const twemojiPack = z.record(z.string(), z.string());

/** The code points of a string, one per character. */
export const codePoints = (text: string): number[] =>
  // sonarjs/null-dereference is a false positive: Array.from yields each character as a string.
  // eslint-disable-next-line sonarjs/null-dereference
  Array.from(text, char => char.codePointAt(0) ?? -1);

/** Twemoji's file name for a grapheme: code points in hex, joined by "-". */
const emojiKey = (grapheme: string) =>
  codePoints(grapheme)
    // sonarjs/null-dereference is a false positive: codePoints returns numbers only.
    // eslint-disable-next-line sonarjs/null-dereference
    .map(cp => cp.toString(16))
    .join('-');

const CMAP_TAG = 0x63_6d_61_70;

/** Format 12 maps ranges of code points to glyphs; every code point in a group has one. */
function format12CodePoints(view: DataView, at: number, found: Set<number>) {
  const groups = view.getUint32(at + 12);
  for (let i = 0; i < groups; i += 1) {
    const group = at + 16 + i * 12;
    for (let cp = view.getUint32(group); cp <= view.getUint32(group + 4); cp += 1) {
      found.add(cp);
    }
  }
}

/** Format 4 maps BMP segments, through a delta or a glyph array; glyph 0 means none. */
function format4CodePoints(view: DataView, at: number, found: Set<number>) {
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let i = 0; i < segments; i += 1) {
    const start = view.getUint16(starts + i * 2);
    const end = Math.min(view.getUint16(ends + i * 2), 0xff_fe);
    const delta = view.getUint16(deltas + i * 2);
    const rangeOffset = view.getUint16(rangeOffsets + i * 2);
    for (let cp = start; cp <= end; cp += 1) {
      const glyph =
        rangeOffset === 0
          ? (cp + delta) % 0x1_00_00
          : view.getUint16(rangeOffsets + i * 2 + rangeOffset + (cp - start) * 2);
      if (glyph !== 0) {
        found.add(cp);
      }
    }
  }
}

/**
 * The code points a font maps, from its cmap's Unicode subtable (format 12, or format 4 for
 * the BMP). Read here rather than through satori, which keeps its parsed fonts to itself.
 */
export function cmapCodePoints(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const found = new Set<number>();
  const record = Array.from({ length: view.getUint16(4) }, (_, i) => 12 + i * 16).find(
    at => view.getUint32(at) === CMAP_TAG,
  );
  if (record === undefined) {
    return found;
  }
  const cmap = view.getUint32(record + 8);
  const subtables = new Map(
    Array.from({ length: view.getUint16(cmap + 2) }, (_, i) => {
      const at = cmap + view.getUint32(cmap + 8 + i * 8);
      return [view.getUint16(at), at] as const;
    }),
  );
  const format12 = subtables.get(12);
  const format4 = subtables.get(4);
  if (format12 !== undefined) {
    format12CodePoints(view, format12, found);
  } else if (format4 !== undefined) {
    format4CodePoints(view, format4, found);
  }
  return found;
}

/** Keeps a successful load; forgets a failed one (after logging it) so the next card retries. */
function once<T>(what: string, load: () => Promise<T>): () => Promise<T | undefined> {
  let loading: Promise<T> | undefined;
  return async () => {
    loading ??= load();
    try {
      return await loading;
    } catch (error) {
      loading = undefined;
      console.error(`[og] could not read the ${what}; those characters render as boxes`, error);
      return undefined;
    }
  };
}

/** Reads the fallbacks from the folder holding `fonts/` and `emoji/` (`domain/og`). */
export function createOgFallbacks(dir: string): OgFallbacks {
  const emojiPack = once('Twemoji pack', async () => {
    const packed = await readFile(path.join(dir, 'emoji', 'twemoji.json.br'));
    const json = await unbrotli(packed);
    const pack = twemojiPack.parse(JSON.parse(json.toString('utf8')));
    return new Map(Object.entries(pack));
  });
  const cjk = once('Noto Sans CJK fonts', async () => {
    const [regular, semiBold] = await Promise.all([
      readFile(path.join(dir, 'fonts', 'NotoSansCJKkr-Regular.otf')),
      readFile(path.join(dir, 'fonts', 'NotoSansCJKkr-SemiBold.otf')),
    ]);
    const covered = cmapCodePoints(regular);
    return {
      fonts: [
        { name: 'Noto Sans CJK KR', weight: 400, data: regular },
        { name: 'Noto Sans CJK KR', weight: 600, data: semiBold },
      ],
      covers: (char: string) => codePoints(char).every(cp => covered.has(cp)),
    } satisfies OgCjkFallback;
  });
  return {
    emoji: async grapheme => {
      const pack = await emojiPack();
      // Twemoji drops U+FE0F from its file names except inside ZWJ sequences; try both.
      // sonarjs/null-dereference is a false positive: satori passes the grapheme as a string.
      // eslint-disable-next-line sonarjs/null-dereference
      const stripped = grapheme.replaceAll(VS16, '');
      const named = grapheme.includes(ZWJ) ? grapheme : stripped;
      return pack?.get(emojiKey(named)) ?? pack?.get(emojiKey(stripped));
    },
    cjk,
  };
}
