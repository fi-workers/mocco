// The production embedder: an embedding model through Vercel's AI Gateway (OpenAI-compatible
// embeddings). The model is configurable (FEEDBACK_EMBEDDING_MODEL); without AI_GATEWAY_API_KEY
// there is no embedder and duplicate detection matches by title words only.
import { z } from 'zod';

import type { Embedder, Embeddings } from '@backend/domain/feedback/embed/Embedder';

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/embeddings';
/** A sweep's call waits this long at most; the next sweep tries again. */
const TIMEOUT_MS = 20_000;

const answerSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()).min(1) })),
});

export class AiGatewayEmbedder implements Embedder {
  readonly model: string;

  constructor(private readonly opts: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    this.model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  }

  async embed(texts: readonly string[]): Promise<Embeddings> {
    if (texts.length === 0) {
      return { model: this.model, dims: 0, vectors: [] };
    }
    const response = await (this.opts.fetch ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`The embedder answered ${String(response.status)}`);
    }
    const answer = answerSchema.safeParse(await response.json());
    if (!answer.success) {
      throw new Error("The embedder's answer had no embeddings");
    }
    const vectors = answer.data.data.toSorted((left, right) => left.index - right.index).map(row => row.embedding);
    const dims = vectors[0]?.length ?? 0;
    if (vectors.length !== texts.length || vectors.some(vector => vector.length !== dims)) {
      throw new Error("The embedder's answer didn't have one vector of one length per text");
    }
    return { model: this.model, dims, vectors };
  }
}

/** The embedder for this deployment, when AI_GATEWAY_API_KEY is set; otherwise none. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined means "not configured", like the other *FromEnv factories
export function embedderFromEnv(env: {
  AI_GATEWAY_API_KEY?: string;
  FEEDBACK_EMBEDDING_MODEL?: string;
}): Embedder | undefined {
  if (env.AI_GATEWAY_API_KEY === undefined) {
    return undefined;
  }
  return new AiGatewayEmbedder({
    apiKey: env.AI_GATEWAY_API_KEY,
    ...(env.FEEDBACK_EMBEDDING_MODEL !== undefined && { model: env.FEEDBACK_EMBEDDING_MODEL }),
  });
}
