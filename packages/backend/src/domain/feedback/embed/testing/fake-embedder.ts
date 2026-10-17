// A deterministic embedder for tests (#181). By default a text's vector counts its words, each
// word hashed to one of `dims` axes, so texts sharing words point the same way. `vectorOf`
// replaces that (to say two texts mean the same with no word in common). It records every call;
// `failWith` makes every call throw (an outage).
/* eslint-disable sonarjs/null-dereference -- every value here is a text's or a word's string, never null */
import type { Embedder, Embeddings } from '@backend/domain/feedback/embed/Embedder';

const DIMS = 32;

/** The axis a word counts on. */
const axisOf = (word: string): number =>
  Array.from(word, char => char.codePointAt(0) ?? 0).reduce((hash, code) => (hash * 31 + code) % DIMS, 7);

const hashedWords = (text: string): number[] => {
  const axes = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(word => axisOf(word));
  return Array.from({ length: DIMS }, (_, axis) => axes.filter(found => found === axis).length);
};

export class FakeEmbedder implements Embedder {
  readonly model: string;

  /** Every call's texts, in order. */
  readonly calls: string[][] = [];

  constructor(private readonly opts: { model?: string; vectorOf?: (text: string) => number[]; failWith?: Error } = {}) {
    this.model = opts.model ?? 'fake-embedding';
  }

  /** Every text sent, across calls. */
  get sent(): string[] {
    return this.calls.flat();
  }

  async embed(texts: readonly string[]): Promise<Embeddings> {
    this.calls.push([...texts]);
    if (this.opts.failWith !== undefined) {
      throw this.opts.failWith;
    }
    const vectors = texts.map(text => this.opts.vectorOf?.(text) ?? hashedWords(text));
    return await Promise.resolve({ model: this.model, dims: vectors[0]?.length ?? DIMS, vectors });
  }
}
