// The example's server: serves the static page and the built SDK files, and signs the
// end-user token for the "signed-in" user, which a real app does on its own server after its
// own sign-in. No dependencies; run it with `node server.mjs` (see README.md).
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`Set ${name} (see README.md)`);
    process.exit(1);
  }
  return value;
};

const port = Number(env('PORT', '4315'));
const config = {
  publishableKey: env('MOCCO_PUBLISHABLE_KEY'),
  board: env('MOCCO_BOARD', 'ideas'),
  // Leave unset for Mocco's API; set it for a self-hosted or local Mocco.
  ...(process.env.MOCCO_API_URL !== undefined && { baseUrl: process.env.MOCCO_API_URL }),
};
// The project's identity secret (Messenger settings): it stays on the server.
const identitySecret = env('MOCCO_IDENTITY_SECRET');

const here = new URL('.', import.meta.url).pathname;
// The built SDKs in this repository (`yarn sdk:build`); an app installs @mocco/js instead.
const roots = {
  '/sdk/js/': join(here, '../../packages/sdk-js/dist/'),
  '/sdk/core/': join(here, '../../packages/sdk-core/dist/'),
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };

const base64url = value => Buffer.from(value).toString('base64url');

/** An HS256 JWT for `sub`, expiring in ten minutes (Mocco takes at most an hour). */
function endUserToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({ sub, iat: now, exp: now + 600 }),
  )}`;
  return `${head}.${createHmac('sha256', identitySecret).update(head).digest('base64url')}`;
}

/** The file a path names, or undefined outside the page and the SDK folders. */
function fileOf(path) {
  if (path === '/' || path === '/index.html') {
    return join(here, 'index.html');
  }
  for (const [prefix, root] of Object.entries(roots)) {
    if (path.startsWith(prefix)) {
      const file = normalize(join(root, path.slice(prefix.length)));
      return file.startsWith(root) ? file : undefined;
    }
  }
  return undefined;
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/config.json') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
    return;
  }
  if (pathname === '/api/mocco-token') {
    // A real app answers for the user its own session names, and 401 without one.
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ token: endUserToken('user-42') }));
    return;
  }
  const file = fileOf(pathname);
  try {
    if (file === undefined) {
      throw new Error('not found');
    }
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, () => {
  console.log(`Example on http://localhost:${port} (board "${config.board}")`);
});
