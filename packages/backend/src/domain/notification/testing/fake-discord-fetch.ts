// A scripted, in-process stand-in for `fetch` that the Discord sender and the
// OAuth exchange are constructed with in tests. Each call takes the next reply
// in the script and records the request, so a test asserts both what was sent
// and how the result was classified. It is a fake injected through the
// constructor, not a module mock.

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

/** A scripted reply: a response, a thrown network error, or no answer until aborted. */
export type FakeReply = Response | { throws: Error } | { hang: true };

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return await new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

export function createFakeDiscordFetch(...script: FakeReply[]) {
  const replies = [...script];
  const requests: RecordedRequest[] = [];

  const fake: typeof fetch = async (input, init) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: requestUrl(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift();
    if (reply === undefined) {
      throw new Error('fake Discord fetch: no scripted reply left');
    }
    if (reply instanceof Response) {
      return reply;
    }
    if ('throws' in reply) {
      throw reply.throws;
    }
    return await hangUntilAborted(init?.signal);
  };

  return { fetch: fake, requests };
}
