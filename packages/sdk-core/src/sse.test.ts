/* eslint-disable n/no-unsupported-features/node-builtins -- ReadableStream ships in every supported runtime */
import { describe, expect, it } from 'vitest';

import { readServerSentEvents } from './sse';

/** A response whose body arrives in exactly these chunks (one per pull). */
const streamOf = (...chunks: string[]) => {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = pending.shift();
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(next));
        }
      },
    }),
  );
};

/** Every value of an async iterator, in order. */
async function collect<T>(iterator: AsyncIterator<T>, values: T[] = []): Promise<T[]> {
  const next = await iterator.next();
  return next.done === true ? values : await collect(iterator, [...values, next.value]);
}

describe('readServerSentEvents', () => {
  it('parses events split across chunks, skipping comments and retry', async () => {
    const response = streamOf(
      'retry: 2000\n\n: ping\n\nid: 7\nevent: message\nda',
      'ta: {"type":"refetchEvaluation"}\n\ndata: line one\ndata: line two\n\n',
    );
    const events = await collect(readServerSentEvents(response));

    expect(events).toEqual([
      { id: '7', event: 'message', data: '{"type":"refetchEvaluation"}' },
      { event: 'message', data: 'line one\nline two' },
    ]);
  });
});
