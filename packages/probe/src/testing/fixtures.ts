// Local servers for the check tests: an HTTP and an HTTPS server with the same routes, a TCP
// listener, and a port nothing listens on. The HTTPS certificate is a checked-in self-signed
// one for localhost and 127.0.0.1 with a known expiry; `yarn test` trusts it through
// NODE_EXTRA_CA_CERTS, so the checks verify it like any other certificate.
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';

/** The fixture certificate's notAfter. */
export const FIXTURE_CERT_EXPIRES_AT = new Date('2036-10-01T00:00:00.000Z');

// eslint-disable-next-line n/no-sync -- read once while a test server starts
const fixtureFile = (name: string) => readFileSync(new URL(name, import.meta.url));

const MEGABYTE = 1024 * 1024;

/** The routes both fixture servers answer. */
function handle(request: IncomingMessage, response: ServerResponse, origin: () => string): void {
  const url = new URL(request.url ?? '/', origin());
  const route = url.pathname;
  if (route === '/ok') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('hello from the fixture');
    return;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- route is a string, never null
  if (route.startsWith('/status/')) {
    response.writeHead(Number(route.slice('/status/'.length))).end('status');
    return;
  }
  if (route === '/slow') {
    setTimeout(
      () => {
        response.writeHead(200).end('slow but fine');
      },
      Number(url.searchParams.get('ms') ?? '100'),
    );
    return;
  }
  if (route === '/hang') {
    // Never answers; the check's deadline has to end it.
    return;
  }
  if (route === '/redirect') {
    const status = Number(url.searchParams.get('status') ?? '302');
    response.writeHead(status, { location: url.searchParams.get('to') ?? '/ok' }).end();
    return;
  }
  if (route === '/loop') {
    response.writeHead(302, { location: '/loop' }).end();
    return;
  }
  if (route === '/method') {
    response.writeHead(200).end(`method=${request.method ?? ''}`);
    return;
  }
  if (route === '/big') {
    // The keyword sits just past the first megabyte, where a check stops reading.
    response.writeHead(200);
    response.write(Buffer.alloc(MEGABYTE, 'a'));
    response.end('needle');
    return;
  }
  response.writeHead(404).end('not found');
}

export interface FixtureServer {
  url: (path: string) => string;
  port: number;
  close: () => Promise<void>;
}

const listen = async (server: Server | TcpServer): Promise<number> =>
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const closer = (server: Server | TcpServer) => async () => {
  if ('closeAllConnections' in server) {
    server.closeAllConnections();
  }
  await new Promise<void>(resolve => {
    server.close(() => {
      resolve();
    });
  });
};

export async function startHttpFixture(protocol: 'http' | 'https' = 'http'): Promise<FixtureServer> {
  let base = '';
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response, () => base);
  };
  const server =
    protocol === 'https'
      ? createHttpsServer({ key: fixtureFile('fixture-key.pem'), cert: fixtureFile('fixture-cert.pem') }, handler)
      : createHttpServer(handler);
  const port = await listen(server);
  // https uses the certificate's name; http the address (a hosted-policy test allows exactly it).
  base = protocol === 'https' ? `https://localhost:${port}` : `http://127.0.0.1:${port}`;
  return { url: path => `${base}${path}`, port, close: closer(server) };
}

export async function startTcpFixture(): Promise<FixtureServer> {
  const server = createTcpServer(socket => {
    socket.end();
  });
  const port = await listen(server);
  return { url: () => `127.0.0.1:${port}`, port, close: closer(server) };
}

/** A port that was free a moment ago: connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listen(server);
  await closer(server)();
  return port;
}
