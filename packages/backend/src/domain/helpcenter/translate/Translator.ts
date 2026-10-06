// The help center's translation port (#96, #212): segments of an article (markdown/segment.ts)
// into one language. The production driver calls an LLM (ai-gateway.ts); tests pass a
// fake (testing/fake-translator.ts). Only ids and placeholder text cross it: what the
// placeholders stand for never leaves Mocco.

export interface TranslatableSegment {
  readonly id: string;
  /** Text with `⟦n⟧` and `⟦n⟧…⟦/n⟧` placeholders, which the answer must carry verbatim. */
  readonly text: string;
}

export interface TranslateSegmentsInput {
  sourceLocale: string;
  targetLocale: string;
  segments: readonly TranslatableSegment[];
  /**
   * Glossary terms these segments contain, each to be translated exactly as `target` (#214).
   * Kept terms never appear: they are placeholders already.
   */
  glossary?: readonly { readonly term: string; readonly target: string }[];
  /** These segments' last answers were refused (a placeholder lost or a link added): ask more strictly. */
  isRetry?: boolean;
}

export interface Translator {
  /** A short name for what translated (the model), stored nowhere secret. */
  readonly name: string;
  /** One answer per segment it could translate, by id; a missing one counts as refused. */
  translateSegments(input: TranslateSegmentsInput): Promise<TranslatableSegment[]>;
}

/** The translator answered, but not with a usable translation — don't retry the same input. */
export class TranslationRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranslationRejectedError';
  }
}
