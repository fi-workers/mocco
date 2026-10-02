// The help center's translation port (#96): one article's title and Markdown into one
// language. The production driver calls an LLM (ai-gateway.ts); tests pass a fake.

export interface TranslateInput {
  sourceLocale: string;
  targetLocale: string;
  title: string;
  /** Markdown; the result must keep its structure (see validate.ts). */
  body: string;
}

export interface Translator {
  /** A short name for what translated (the model), stored nowhere secret. */
  readonly name: string;
  translate(input: TranslateInput): Promise<{ title: string; body: string }>;
}

/** The translator answered, but not with a usable translation — don't retry the same input. */
export class TranslationRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TranslationRejectedError';
  }
}
