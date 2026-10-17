// The feedback domain's embedding port (#181): texts in, one vector each out, from one model.
// The production driver calls an embedding model through the AI Gateway (ai-gateway.ts); tests
// pass a deterministic fake (testing/fake-embedder.ts). Without one configured, duplicate
// detection matches by title words only.

export interface Embeddings {
  /** The model that made the vectors: vectors from different models are never compared. */
  model: string;
  /** Every vector's length. */
  dims: number;
  /** One per text, in the order sent. */
  vectors: number[][];
}

export interface Embedder {
  /** The model `embed` uses, known before calling it (to find vectors made by another). */
  readonly model: string;
  embed(texts: readonly string[]): Promise<Embeddings>;
}
