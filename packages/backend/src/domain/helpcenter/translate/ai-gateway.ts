// The production translator: an LLM through Vercel's AI Gateway (OpenAI-compatible chat
// completions). The model is configurable (HELP_TRANSLATION_MODEL); without
// AI_GATEWAY_API_KEY there is no translator and the help center serves the source.
import { z } from 'zod';

import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type { TranslateInput, Translator } from '@backend/domain/helpcenter/translate/Translator';

export const DEFAULT_TRANSLATION_MODEL = 'anthropic/claude-sonnet-5';
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';

const answerSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const translationSchema = z.object({ title: z.string().min(1), body: z.string() });

const SYSTEM_PROMPT = [
  'You translate help center articles for a software product.',
  'Translate the title and the Markdown body from the source language into the target language.',
  'Keep the Markdown exactly as it is: the same headings, lists, tables, quotes and emphasis,',
  'code blocks and inline code unchanged, link and image URLs unchanged (translate link text and image alt text).',
  'Keep product names, button labels in quotes and anything in code as they are unless the target language has an established term.',
  'Write naturally for a reader of the target language. Answer with JSON only: {"title": "...", "body": "..."}.',
].join(' ');

export class AiGatewayTranslator implements Translator {
  readonly name: string;

  constructor(private readonly opts: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    this.name = opts.model ?? DEFAULT_TRANSLATION_MODEL;
  }

  async translate(input: TranslateInput): Promise<{ title: string; body: string }> {
    const response = await (this.opts.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.name,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              sourceLanguage: input.sourceLocale,
              targetLanguage: input.targetLocale,
              title: input.title,
              body: input.body,
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
      throw new TranslationRejectedError("The translator's answer had no title or body");
    }
    return translation.data;
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
