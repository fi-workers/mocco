// A minimal Server-Sent Events reader over a fetch response body, for runtimes without
// EventSource (Node, React Native) or where a header must be sent. Parses `id`, `event`
// and `data` (multi-line data joined with \n); comments and `retry` are skipped.

export interface ServerSentEvent {
  id?: string;
  event: string;
  data: string;
}

/* eslint-disable sonarjs/null-dereference -- everything parsed here is a decoded string */
interface Fields {
  id?: string;
  event?: string;
  data: string[];
}

/** Fold one `field: value` line into the event's fields (comments and unknown fields are skipped). */
function withLine(fields: Fields, line: string): Fields {
  if (line === '' || line.startsWith(':')) {
    return fields;
  }
  const colon = line.indexOf(':');
  const name = colon === -1 ? line : line.slice(0, colon);
  const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');
  if (name === 'data') {
    return { ...fields, data: [...fields.data, value] };
  }
  return name === 'id' || name === 'event' ? { ...fields, [name]: value } : fields;
}

/** One event block, or undefined for a block without data (a comment, a `retry`). */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "no event here" answer
function parseBlock(block: string): ServerSentEvent | undefined {
  const fields = block.split('\n').reduce<Fields>((current, line) => withLine(current, line), { data: [] });
  if (fields.data.length === 0) {
    return undefined;
  }
  return {
    ...(fields.id !== undefined && { id: fields.id }),
    event: fields.event ?? 'message',
    data: fields.data.join('\n'),
  };
}

/** The events of an SSE response, in order, until the stream ends. */
export async function* readServerSentEvents(response: Response): AsyncGenerator<ServerSentEvent> {
  const { body } = response;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read in order
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      const events = blocks.map(block => parseBlock(block)).filter(event => event !== undefined);
      yield* events;
    }
  } finally {
    reader.releaseLock();
  }
}
/* eslint-enable sonarjs/null-dereference */
