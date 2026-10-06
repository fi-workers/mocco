// Segment translation (#212): the segments translation memory had no entry for go to the
// translator in batches. Each answer is checked per segment (markdown/validate.ts); a
// refused segment is asked again, more strictly, a bounded number of times. Accepted
// translations are handed back after every batch, so a run that stops halfway (an
// outage, a timeout) keeps what it already paid for.
import { segmentProblem } from '@backend/domain/helpcenter/markdown/validate';
import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type { Segment } from '@backend/domain/helpcenter/markdown/segment';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';

/** Tries per segment: the first ask and two stricter retries. */
export const MAX_SEGMENT_ATTEMPTS = 3;

/** Source characters per translator call (about 4k tokens of mixed-script text). */
export const BATCH_CHARACTERS = 8000;

/** A segment still refused after its last try, and why. */
export interface Refusal {
  readonly segment: Segment;
  readonly problem: string;
}

export interface MachineResult {
  /** Valid translations by source segment hash. */
  readonly translated: ReadonlyMap<string, string>;
  readonly refused: readonly Refusal[];
}

/** One segment per distinct hash: the same text twice in an article is sent once. */
export function distinctByHash<T extends { readonly hash: string }>(segments: readonly T[]): T[] {
  const seen = new Set<string>();
  return segments.filter(segment => {
    if (seen.has(segment.hash)) {
      return false;
    }
    seen.add(segment.hash);
    return true;
  });
}

/** What a run is metered by: the characters of the segment text sent. */
export function charactersOf(segments: readonly { readonly text: string }[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

/** Consecutive batches of at most `budget` characters; a longer segment goes alone. */
export function batchesOf(segments: readonly Segment[], budget = BATCH_CHARACTERS): Segment[][] {
  return segments.reduce<Segment[][]>((batches, segment) => {
    const last = batches.at(-1);
    if (last !== undefined && charactersOf(last) + segment.text.length <= budget) {
      last.push(segment);
    } else {
      batches.push([segment]);
    }
    return batches;
  }, []);
}

interface TranslateRequest {
  translator: Translator;
  sourceLocale: string;
  targetLocale: string;
}

/** One call: each answer of the batch accepted or refused. Throws an outage. */
async function askBatch(
  batch: readonly Segment[],
  request: TranslateRequest,
  isRetry: boolean,
): Promise<{ accepted: { hash: string; text: string }[]; refused: Refusal[] }> {
  let answers: Map<string, string>;
  try {
    const answered = await request.translator.translateSegments({
      sourceLocale: request.sourceLocale,
      targetLocale: request.targetLocale,
      segments: batch.map(({ id, text }) => ({ id, text })),
      ...(isRetry && { isRetry: true }),
    });
    answers = new Map(answered.map(({ id, text }) => [id, text]));
  } catch (error) {
    if (!(error instanceof TranslationRejectedError)) {
      throw error;
    }
    return { accepted: [], refused: batch.map(segment => ({ segment, problem: error.message })) };
  }
  const checked = batch.map(segment => {
    const text = answers.get(segment.id);
    return { segment, text, problem: text === undefined ? 'no translation came back' : segmentProblem(segment, text) };
  });
  return {
    accepted: checked.flatMap(({ segment, text, problem }) =>
      problem === null && text !== undefined ? [{ hash: segment.hash, text }] : [],
    ),
    refused: checked.flatMap(({ segment, problem }) => (problem === null ? [] : [{ segment, problem }])),
  };
}

/**
 * Translate `segments` (distinct, none in memory) into the target language. Throws what
 * the translator throws other than `TranslationRejectedError` (an outage), after
 * `onAccepted` saw every batch that came back before it.
 */
export async function translateMisses(
  segments: readonly Segment[],
  request: TranslateRequest,
  onAccepted: (accepted: readonly { hash: string; text: string }[]) => Promise<void>,
): Promise<MachineResult> {
  const translated = new Map<string, string>();
  let refused: Refusal[] = [];
  let waiting = [...segments];
  // Attempts run in order: each retries what the last refused.
  for (let attempt = 1; attempt <= MAX_SEGMENT_ATTEMPTS && waiting.length > 0; attempt += 1) {
    refused = [];
    // eslint-disable-next-line no-restricted-syntax -- batches run in order, each checkpointed before the next is sent
    for (const batch of batchesOf(waiting)) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time, so a stop keeps every earlier batch
      const answer = await askBatch(batch, request, attempt > 1);
      // eslint-disable-next-line no-restricted-syntax -- collects the accepted answers
      for (const { hash, text } of answer.accepted) {
        translated.set(hash, text);
      }
      refused.push(...answer.refused);
      // eslint-disable-next-line no-await-in-loop -- the checkpoint lands before the next call goes out
      await onAccepted(answer.accepted);
    }
    waiting = refused.map(({ segment }) => segment);
  }
  return { translated, refused };
}
