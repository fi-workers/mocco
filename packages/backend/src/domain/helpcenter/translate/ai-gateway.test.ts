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

const input = {
  sourceLocale: 'ko',
  targetLocale: 'en',
  segments: [
    { id: 'title', text: '위젯' },
    { id: 's0', text: '⟦0⟧설정⟦/0⟧을 엽니다' },
  ],
};

/** The system and user messages a request carried. */
const messagesOf = (request: { body: Record<string, unknown> } | undefined) =>
  (request?.body.messages ?? []) as { role: string; content: string }[];

describe('AiGatewayTranslator', () => {
  it('sends only segment ids and placeholder text to the configured model and reads the JSON answer', async () => {
    const segments = [
      { id: 'title', text: 'Widget' },
      { id: 's0', text: 'Open ⟦0⟧Settings⟦/0⟧' },
    ];
    const gateway = answering(JSON.stringify({ segments }));
    const translator = new AiGatewayTranslator({
      apiKey: 'key-1',
      model: 'anthropic/claude-sonnet-5',
      fetch: gateway.fetch,
    });

    const result = await translator.translateSegments(input);
    await translator.translateSegments({ ...input, isRetry: true });

    expect(result).toEqual(segments);
    expect(gateway.requests[0]).toMatchObject({
      url: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      auth: 'Bearer key-1',
      body: { model: 'anthropic/claude-sonnet-5', response_format: { type: 'json_object' } },
    });
    const [system, user] = messagesOf(gateway.requests[0]);
    expect(JSON.parse(user?.content ?? '')).toEqual({
      sourceLanguage: 'ko',
      targetLanguage: 'en',
      segments: input.segments,
    });
    expect(system?.content).not.toContain('refused');
    expect(messagesOf(gateway.requests[1])[0]?.content).toContain('refused');
  });

  it('rejects an answer that is not the JSON it asked for, and throws plainly on an outage', async () => {
    const prose = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('Sure! Here is it.').fetch });
    const empty = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('{"text":"x"}').fetch });
    const down = new AiGatewayTranslator({ apiKey: 'k', fetch: answering('', 503).fetch });

    await expect(prose.translateSegments(input)).rejects.toBeInstanceOf(TranslationRejectedError);
    await expect(empty.translateSegments(input)).rejects.toBeInstanceOf(TranslationRejectedError);
    await expect(down.translateSegments(input)).rejects.not.toBeInstanceOf(TranslationRejectedError);
  });

  it('exists only with an API key', () => {
    expect(translatorFromEnv({})).toBeUndefined();
    expect(translatorFromEnv({ AI_GATEWAY_API_KEY: 'k' })?.name).toBe('anthropic/claude-sonnet-5');
    expect(translatorFromEnv({ AI_GATEWAY_API_KEY: 'k', HELP_TRANSLATION_MODEL: 'openai/gpt-5' })?.name).toBe(
      'openai/gpt-5',
    );
  });
});
