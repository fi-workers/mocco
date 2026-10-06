// The production translator: an LLM through Vercel's AI Gateway (OpenAI-compatible chat
// completions). The model is configurable (HELP_TRANSLATION_MODEL); without
// AI_GATEWAY_API_KEY there is no translator and the help center serves the source.
import { z } from 'zod';

import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type {
  TranslatableSegment,
  TranslateSegmentsInput,
  Translator,
} from '@backend/domain/helpcenter/translate/Translator';

export const DEFAULT_TRANSLATION_MODEL = 'anthropic/claude-sonnet-5';
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';

const answerSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const translationSchema = z.object({
  segments: z.array(z.object({ id: z.string().min(1), text: z.string() })),
});

const SYSTEM_PROMPT = [
  'You translate help center articles for a software product, one segment at a time.',
  'Each segment is a heading, a paragraph, a table cell, an alt text or a title from the article.',
  'Translate the text of every segment from the source language into the target language.',
  'Placeholders like ⟦0⟧ stand for code, links, images and formatting: copy each one exactly once, unchanged.',
  'A pair like ⟦1⟧text⟦/1⟧ wraps text: translate the text inside and keep the pair around it, in the same nesting.',
  'Never add a URL. Keep product names and quoted button labels unless the target language has an established term.',
  'When a glossary is given, translate each of its terms exactly as its target, in every segment that contains it.',
  'Write naturally for a reader of the target language.',
  'Answer with JSON only: {"segments": [{"id": "...", "text": "..."}]}, one entry per segment, with the same ids.',
].join(' ');

const RETRY_NOTE = [
  'Your previous answer for these segments was refused: a placeholder was lost, repeated or changed, a URL was added, or a glossary term was not translated as its target.',
  'Copy every placeholder exactly and use every glossary target as given.',
].join(' ');

export class AiGatewayTranslator implements Translator {
  readonly name: string;

  constructor(private readonly opts: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    this.name = opts.model ?? DEFAULT_TRANSLATION_MODEL;
  }

  async translateSegments(input: TranslateSegmentsInput): Promise<TranslatableSegment[]> {
    const response = await (this.opts.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.name,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.isRetry === true ? `${SYSTEM_PROMPT} ${RETRY_NOTE}` : SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              sourceLanguage: input.sourceLocale,
              targetLanguage: input.targetLocale,
              segments: input.segments.map(({ id, text }) => ({ id, text })),
              ...(input.glossary !== undefined && { glossary: input.glossary }),
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      // Retried by the job: rate limits and outages pass.
      throw new Error(`The translator answered ${response.status}`);
    }
    const answer = answerSchema.safeParse(await response.json());
    const content = answer.success ? answer.data.choices[0]?.message.content : undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content ?? '');
    } catch (error) {
      throw new TranslationRejectedError("The translator didn't answer with JSON", { cause: error });
    }
    const translation = translationSchema.safeParse(parsed);
    if (!translation.success) {
      throw new TranslationRejectedError("The translator's answer had no segments");
    }
    return translation.data.segments;
  }
}

/** The translator for this deployment, when AI_GATEWAY_API_KEY is set; otherwise none. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined means "not configured", like the other *FromEnv factories
export function translatorFromEnv(env: {
  AI_GATEWAY_API_KEY?: string;
  HELP_TRANSLATION_MODEL?: string;
}): Translator | undefined {
  if (env.AI_GATEWAY_API_KEY === undefined) {
    return undefined;
  }
  return new AiGatewayTranslator({
    apiKey: env.AI_GATEWAY_API_KEY,
    ...(env.HELP_TRANSLATION_MODEL !== undefined && { model: env.HELP_TRANSLATION_MODEL }),
  });
}
