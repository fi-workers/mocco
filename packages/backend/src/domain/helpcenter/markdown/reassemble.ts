// Reassembly (#211): translated segment text spliced back into the source's own tree and
// serialized. Structure comes from the source, never from the translator: a segment can
// only replace its own text, and every placeholder is checked (validate.ts) before it is
// put back. A segment without a translation keeps its source text.
import { restorePlain } from '@backend/domain/helpcenter/markdown/protect';
import { locateSegments, segmentTitle } from '@backend/domain/helpcenter/markdown/segment';
import { parseMarkdown, stringifyMarkdown } from '@backend/domain/helpcenter/markdown/tree';
import { segmentProblem } from '@backend/domain/helpcenter/markdown/validate';
import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type { ProtectOptions } from '@backend/domain/helpcenter/markdown/protect';
import type { Segment } from '@backend/domain/helpcenter/markdown/segment';

/** Translations by segment id. */
export type SegmentTranslations = ReadonlyMap<string, string>;

const checked = (segment: Segment, text: string) => {
  const problem = segmentProblem(segment, text);
  if (problem !== null) {
    throw new TranslationRejectedError(`Segment ${segment.id} was refused: ${problem}`);
  }
  return text;
};

/**
 * The source Markdown with each segment's translation in place, in the house style
 * (tree.ts). Throws `TranslationRejectedError` when a translation fails validation.
 * `options` must be the ones the segments were made with.
 */
export function reassemble(source: string, translations: SegmentTranslations, options: ProtectOptions = {}): string {
  const tree = parseMarkdown(source);
  // eslint-disable-next-line no-restricted-syntax -- each segment writes into the tree, a side effect
  for (const { segment, apply } of locateSegments(tree, options)) {
    const translated = translations.get(segment.id);
    if (translated !== undefined) {
      apply(checked(segment, translated));
    }
  }
  return stringifyMarkdown(tree);
}

/** A translated title with its placeholders restored. */
export function reassembleTitle(source: string, translated: string, options: ProtectOptions = {}): string {
  const segment = segmentTitle(source, options);
  return restorePlain(checked(segment, translated), segment.slots);
}
