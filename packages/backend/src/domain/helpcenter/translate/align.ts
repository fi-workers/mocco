// A person's translation as translation memory (#212). Their Markdown is segmented like
// the source; where the two line up (the same segment kinds in the same order), each
// translated segment's placeholders are renumbered to the source segment's (matching
// what they hold: the same link target, the same code), and the pair is kept only if it
// validates against the source segment. A reordered or restructured translation keeps
// what lines up and drops the rest, so the machine never reuses a sentence it can't place.
// Both sides are protected with the glossary's kept terms and keyed like the machine's
// entries (translate/glossary.ts), so a run finds the person's sentence under the same key.
import { PLACEHOLDER } from '@backend/domain/helpcenter/markdown/protect';
import { segmentMarkdown, segmentTitle } from '@backend/domain/helpcenter/markdown/segment';
import { segmentProblem } from '@backend/domain/helpcenter/markdown/validate';
import { EMPTY_GLOSSARY, memoryKey } from '@backend/domain/helpcenter/translate/glossary';

import type { Slot } from '@backend/domain/helpcenter/markdown/protect';
import type { Segment } from '@backend/domain/helpcenter/markdown/segment';
import type { LocaleGlossary } from '@backend/domain/helpcenter/translate/glossary';

/** What a placeholder holds, minus anything a translation may change (wrapped text, alt text). */
function slotKey(slot: Slot): string {
  if (slot.type === 'literal') {
    return `literal:${slot.value}`;
  }
  const { node } = slot;
  const target =
    ('url' in node ? node.url : undefined) ??
    ('identifier' in node ? node.identifier : undefined) ??
    ('value' in node ? node.value : undefined) ??
    '';
  return `${slot.type}:${node.type}:${target}`;
}

/** `translated`'s text with its placeholders renumbered to `source`'s, or null when one can't be matched. */
function renumbered(source: Segment, translated: Segment): string | null {
  const used = new Set<number>();
  const sourceKeys = source.slots.map(slot => slotKey(slot));
  const mapping = translated.slots.map(slot => {
    const key = slotKey(slot);
    const index = sourceKeys.findIndex((candidate, i) => candidate === key && !used.has(i));
    if (index !== -1) {
      used.add(index);
    }
    return index;
  });
  if (mapping.includes(-1)) {
    return null;
  }
  return translated.text.replaceAll(
    PLACEHOLDER,
    (_whole, close: string, n: string) => `⟦${close}${String(mapping[Number(n)])}⟧`,
  );
}

/**
 * The segments of a person's translation that line up with the source's, as
 * translation memory entries keyed by the source segment's hash.
 */
export function alignedSegments(
  source: { title: string; body: string },
  translation: { title: string; body: string },
  glossary: LocaleGlossary = EMPTY_GLOSSARY,
): { sourceHash: string; text: string }[] {
  const options = { keep: glossary.keep };
  const sourceBody = segmentMarkdown(source.body, options);
  const translatedBody = segmentMarkdown(translation.body, options);
  const isBodyAligned =
    sourceBody.length === translatedBody.length &&
    sourceBody.every((segment, i) => translatedBody[i]?.kind === segment.kind);
  const pairs: [Segment, Segment][] = [
    [segmentTitle(source.title, options), segmentTitle(translation.title, options)],
    ...(isBodyAligned
      ? sourceBody.map((segment, i): [Segment, Segment] => [segment, translatedBody[i] ?? segment])
      : []),
  ];
  return pairs.flatMap(([from, to]) => {
    const text = renumbered(from, to);
    if (text === null || segmentProblem(from, text) !== null) {
      return [];
    }
    return [{ sourceHash: memoryKey(from, glossary), text }];
  });
}
