import { describe, expect, it } from 'vitest';

import { AiGatewayEmbedder, DEFAULT_EMBEDDING_MODEL, embedderFromEnv } from '@backend/domain/feedback/embed/ai-gateway';

/** A fetch that answers `body` (or the given status), recording each request. */
const answering = (body: unknown, status = 200) => {
  const requests: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: new Headers(init?.headers).get('authorization'),
    });
    return await Promise.resolve(Response.json(body, { status }));
  };
  return { requests, fetch: fakeFetch };
};

describe('AiGatewayEmbedder', () => {
  it('sends the texts to the configured model and returns the vectors in the order sent', async () => {
    const gateway = answering({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
    const embedder = new AiGatewayEmbedder({
      apiKey: 'key',
      model: 'openai/text-embedding-3-large',
      fetch: gateway.fetch,
    });

    expect(await embedder.embed(['Dark mode', 'Night theme'])).toEqual({
      model: 'openai/text-embedding-3-large',
      dims: 2,
      vectors: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(gateway.requests).toEqual([
      {
        url: 'https://ai-gateway.vercel.sh/v1/embeddings',
        body: { model: 'openai/text-embedding-3-large', input: ['Dark mode', 'Night theme'] },
        auth: 'Bearer key',
      },
    ]);
  });

  it('calls nothing for no texts', async () => {
    const gateway = answering({ data: [] });
    const embedder = new AiGatewayEmbedder({ apiKey: 'key', fetch: gateway.fetch });
    expect(await embedder.embed([])).toEqual({ model: DEFAULT_EMBEDDING_MODEL, dims: 0, vectors: [] });
    expect(gateway.requests).toEqual([]);
  });

  it('throws on an error status or an answer without one vector of one length per text', async () => {
    const failing = new AiGatewayEmbedder({ apiKey: 'key', fetch: answering({}, 429).fetch });
    await expect(failing.embed(['a'])).rejects.toThrow('429');
    const short = new AiGatewayEmbedder({
      apiKey: 'key',
      fetch: answering({ data: [{ index: 0, embedding: [1] }] }).fetch,
    });
    await expect(short.embed(['a', 'b'])).rejects.toThrow('one vector');
    const ragged = new AiGatewayEmbedder({
      apiKey: 'key',
      fetch: answering({
        data: [
          { index: 0, embedding: [1] },
          { index: 1, embedding: [1, 0] },
        ],
      }).fetch,
    });
    await expect(ragged.embed(['a', 'b'])).rejects.toThrow('one vector');
    const garbled = new AiGatewayEmbedder({ apiKey: 'key', fetch: answering({ vectors: [] }).fetch });
    await expect(garbled.embed(['a'])).rejects.toThrow('no embeddings');
  });
});

describe('embedderFromEnv', () => {
  it('is configured by the AI Gateway key, with the default model unless one is named', () => {
    expect(embedderFromEnv({})).toBeUndefined();
    expect(embedderFromEnv({ AI_GATEWAY_API_KEY: 'key' })?.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(embedderFromEnv({ AI_GATEWAY_API_KEY: 'key', FEEDBACK_EMBEDDING_MODEL: 'cohere/embed-v4.0' })?.model).toBe(
      'cohere/embed-v4.0',
    );
  });
});
