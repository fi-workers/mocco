// A deterministic translator for tests (#212): prefixes each segment's text with the
// target language (`EN …`) and keeps every placeholder, so its output always validates. It records
// what it was sent; `refuse` makes chosen answers drop a placeholder or add a link, and
// `beforeAnswer` runs while a call is out (to race a person's save against a run).
import type {
  TranslatableSegment,
  TranslateSegmentsInput,
  Translator,
} from '@backend/domain/helpcenter/translate/Translator';

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
      beforeAnswer?: () => Promise<void>;
    } = {},
  ) {}

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
      return { id, text: `${input.targetLocale.toUpperCase()} ${text}` };
    });
  }
}
