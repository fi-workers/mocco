// A deterministic translator for tests (#212): prefixes each segment's text with the
// target language (`EN …`), keeps every placeholder and writes each glossary term it was
// given as its translation, so its output always validates. It records what it was sent;
// `refuse` makes chosen answers drop a placeholder or add a link, `rewrite` changes every
// answer (to ignore the glossary, say), and `beforeAnswer` runs while a call is out (to race
// a person's save against a run).
/* eslint-disable sonarjs/null-dereference -- every value here is a segment's or a term's string, never null */
import type {
  TranslatableSegment,
  TranslateSegmentsInput,
  Translator,
} from '@backend/domain/helpcenter/translate/Translator';

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

export class FakeTranslator implements Translator {
  readonly name = 'fake';

  /** Every call, in order. */
  readonly calls: TranslateSegmentsInput[] = [];

  constructor(
    private readonly opts: {
      /** Answer this segment text with a broken translation (a new link) this many times. */
      refuse?: { text: string; times: number };
      /** Throw this error from every call (an outage). */
      failWith?: Error;
      /** Applied to every answer, after the glossary. */
      rewrite?: (text: string) => string;
      beforeAnswer?: () => Promise<void>;
    } = {},
  ) {}

  /** Forget the calls so far (to count what a later change sends). */
  forget(): void {
    this.calls.length = 0;
  }

  /** Every segment text sent, across calls. */
  get sent(): string[] {
    return this.calls.flatMap(call => call.segments.map(({ text }) => text));
  }

  async translateSegments(input: TranslateSegmentsInput): Promise<TranslatableSegment[]> {
    this.calls.push(input);
    await this.opts.beforeAnswer?.();
    if (this.opts.failWith !== undefined) {
      throw this.opts.failWith;
    }
    const { refuse } = this.opts;
    return input.segments.map(({ id, text }) => {
      if (refuse !== undefined && refuse.times > 0 && text === refuse.text) {
        refuse.times -= 1;
        return { id, text: `${text} https://evil.test` };
      }
      const withTerms = (input.glossary ?? []).reduce(
        (written, { term, target }) => written.split(new RegExp(escapeRegExp(term), 'iu')).join(target),
        text,
      );
      const answer = `${input.targetLocale.toUpperCase()} ${withTerms}`;
      return { id, text: this.opts.rewrite?.(answer) ?? answer };
    });
  }
}
