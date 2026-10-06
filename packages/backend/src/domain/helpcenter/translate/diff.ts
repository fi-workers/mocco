// The review's segment diff (#213): what changed in an article's source between the
// revision a translation was made from and the published one, segment by segment, so a
// reviewer sees exactly the sentences to look at. Segments are matched by hash (the same
// key translation memory uses), so a segment counts as changed exactly when a run would
// translate it again. The longest common subsequence keeps unchanged segments in place;
// between two of them, removed and added segments pair up in order as `changed`.
import { SegmentChanges, SegmentKinds } from '@mocco/common/help';

import { restoreInline, restorePlain } from '@backend/domain/helpcenter/markdown/protect';

import type { Segment } from '@backend/domain/helpcenter/markdown/segment';
import type { SegmentChange, SegmentKind } from '@mocco/common/help';
import type { PhrasingContent } from 'mdast';

export interface SegmentDiffEntry {
  readonly change: SegmentChange;
  readonly kind: SegmentKind;
  /** The text in the source the translation was made from; null for an added segment. */
  readonly before: string | null;
  /** The text in the published source; null for a removed segment. */
  readonly after: string | null;
}

/** Kinds whose text is plain (no inline Markdown). */
const PLAIN_KINDS: ReadonlySet<SegmentKind> = new Set([
  SegmentKinds.title,
  SegmentKinds.imageAlt,
  SegmentKinds.linkTitle,
]);

const plainText = (nodes: readonly PhrasingContent[]): string =>
  nodes
    .map(node => {
      if (node.type === 'image') {
        return node.alt ?? '';
      }
      if (node.type === 'break') {
        return ' ';
      }
      if ('value' in node) {
        return node.value;
      }
      return 'children' in node ? plainText(node.children) : '';
    })
    .join('');

/** A segment as a reader sees it: placeholders back to what they hold, formatting dropped. */
export function readableText(segment: Segment): string {
  return PLAIN_KINDS.has(segment.kind)
    ? restorePlain(segment.text, segment.slots)
    : plainText(restoreInline(segment.text, segment.slots));
}

/** Lengths of the longest common suffixes of `a[i..]` and `b[j..]`, by hash. */
function lcsTable(a: readonly Segment[], b: readonly Segment[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      if (row !== undefined) {
        row[j] =
          a[i]?.hash === b[j]?.hash
            ? (table[i + 1]?.[j + 1] ?? 0) + 1
            : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }
  return table;
}

const entry = (change: SegmentChange, before: Segment | undefined, after: Segment | undefined): SegmentDiffEntry => ({
  change,
  kind: (after ?? before)?.kind ?? SegmentKinds.paragraph,
  before: before === undefined ? null : readableText(before),
  after: after === undefined ? null : readableText(after),
});

/** Pair a run of removed and added segments in order; what's left over stays removed or added. */
function pairRun(removed: readonly Segment[], added: readonly Segment[]): SegmentDiffEntry[] {
  const length = Math.max(removed.length, added.length);
  return Array.from({ length }, (_, k) => {
    const before = removed[k];
    const after = added[k];
    if (before !== undefined && after !== undefined) {
      return entry(SegmentChanges.changed, before, after);
    }
    return before === undefined
      ? entry(SegmentChanges.added, undefined, after)
      : entry(SegmentChanges.removed, before, undefined);
  });
}

/** Every segment of `before` and `after`, in the published order, with how each changed. */
export function segmentDiff(before: readonly Segment[], after: readonly Segment[]): SegmentDiffEntry[] {
  const table = lcsTable(before, after);
  const entries: SegmentDiffEntry[] = [];
  let removed: Segment[] = [];
  let added: Segment[] = [];
  let i = 0;
  let j = 0;
  const flush = () => {
    entries.push(...pairRun(removed, added));
    removed = [];
    added = [];
  };
  while (i < before.length || j < after.length) {
    const a = before[i];
    const b = after[j];
    if (a !== undefined && b !== undefined && a.hash === b.hash) {
      flush();
      entries.push(entry(SegmentChanges.same, a, b));
      i += 1;
      j += 1;
    } else if (b === undefined || (a !== undefined && (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) {
      if (a !== undefined) {
        removed.push(a);
      }
      i += 1;
    } else {
      added.push(b);
      j += 1;
    }
  }
  flush();
  return entries;
}
