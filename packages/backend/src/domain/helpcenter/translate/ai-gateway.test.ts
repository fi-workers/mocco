import { describe, expect, it } from 'vitest';

import { AiGatewayTranslator, translatorFromEnv } from '@backend/domain/helpcenter/translate/ai-gateway';
import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

/** A fetch that answers `content` as the model's message (or the given status). */
const answering = (content: string, status = 200) => {
  const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return await Promise.resolve(Response.json({ choices: [{ message: { content } }] }, { status }));
  };
  return { requests, fetch: fakeFetch };
};

const input = { sourceLocale: 'ko', targetLocale: 'en', title: '위젯', body: '## 추가하기' };

describe('AiGatewayTranslator', () => {
  it('sends the article to the configured model and reads the JSON answer', async () => {
    const gateway = answering(JSON.stringify({ title: 'Widget', body: '## Add it' }));
    const translator = new AiGatewayTranslator({
      apiKey: 'key-1',
      model: 'anthropic/claude-sonnet-5',
      fetch: gateway.fetch,
    });

    const result = await translator.translate(input);

    expect(result).toEqual({ title: 'Widget', body: '## Add it' });
    expect(gateway.requests[0]).toMatchObject({
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      auth: 'Bearer key-1',
      body: { model: 'anthropic/claude-sonnet-5', response_format: { type: 'json_object' } },
    });
  });

  it('rejects an answer that is not the JSON it asked for, and throws plainly on an outage', async () => {
    const prose = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('Sure! Here is it.').fetch });
    const empty = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('{"text":"x"}').fetch });
    const down = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('', 503).fetch });

    await expect(prose.translate(input)).rejects.toBeInstanceOf(TranslationRejectedError);
    await expect(empty.translate(input)).rejects.toBeInstanceOf(TranslationRejectedError);
    await expect(down.translate(input)).rejects.not.toBeInstanceOf(TranslationRejectedError);
  });

  it('exists only with an API key', () => {
    expect(translatorFromEnv({})).toBeUndefined();
    expect(translatorFromEnv({ AI_GATEWAY_API_KEY: 'k' })?.name).toBe('anthropic/claude-sonnet-5');
    expect(translatorFromEnv({ AI_GATEWAY_API_KEY: 'k', HELP_TRANSLATION_MODEL: 'openai/gpt-5' })?.name).toBe(
      'openai/gpt-5',
    );
  });
});
