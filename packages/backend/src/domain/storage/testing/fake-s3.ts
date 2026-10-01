// A minimal in-process S3 over HTTP (path-style), enough for the S3 driver's contract
// tests: PutObject, GetObject, HeadObject, DeleteObjects and presigned GET/PUT. It does
// not verify signatures; presigned requests are recognised by their X-Amz-Signature.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { buffer } from 'node:stream/consumers';

interface FakeObject {
  body: Buffer;
  contentType: string;
  etag: string;
}

export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, FakeObject>;
  /** Requests that carried a presigned query (X-Amz-Signature). */
  presignedRequests: string[];
  close: () => Promise<void>;
}

// A loopback fake for tests: plain HTTP on 127.0.0.1.

const LOOPBACK = 'http://127.0.0.1';
const DELETE_KEY = /<Key>([^<]*)<\/Key>/gu;

const notFound = (response: ServerResponse, isHead: boolean) => {
  response.writeHead(404, { 'content-type': 'application/xml' });
  response.end(isHead ? undefined : '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
};

export async function startFakeS3(bucket = 'test-bucket'): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const presignedRequests: string[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', LOOPBACK);
    const [, requestBucket, ...rest] = url.pathname.split('/');
    const key = rest.map(segment => decodeURIComponent(segment)).join('/');
    if (url.searchParams.has('X-Amz-Signature')) {
      presignedRequests.push(`${request.method} ${key}`);
    }
    if (requestBucket !== bucket) {
      notFound(response, request.method === 'HEAD');
      return;
    }
    if (request.method === 'POST' && url.searchParams.has('delete')) {
      const body = await buffer(request);
      const requested = Array.from(body.toString('utf8').matchAll(DELETE_KEY), match => match[1] ?? '');
      const removed = requested.filter(deleted => objects.delete(deleted));
      response.writeHead(200, { 'content-type': 'application/xml', 'x-fake-deleted': String(removed.length) });
      response.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
      return;
    }
    if (request.method === 'PUT') {
      const body = await buffer(request);
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
      objects.set(key, { body, contentType: request.headers['content-type'] ?? 'application/octet-stream', etag });
      response.writeHead(200, { etag });
      response.end();
      return;
    }
    const object = objects.get(key);
    if (object === undefined) {
      notFound(response, request.method === 'HEAD');
      return;
    }
    response.writeHead(200, {
      'content-type': object.contentType,
      'content-length': String(object.body.byteLength),
      etag: object.etag,
    });
    response.end(request.method === 'HEAD' ? undefined : object.body);
  };

  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      await handle(request, response);
    } catch {
      response.writeHead(500);
      response.end();
    }
  };
  const server: Server = createServer((request, response) => {
    respond(request, response);
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `${LOOPBACK}:${port}`,
    bucket,
    objects,
    presignedRequests,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
