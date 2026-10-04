import { createHash, randomUUID } from 'node:crypto';

import { test, expect } from '@playwright/test';
import pg from 'pg';

// An MCP client connecting for the first time, against the real server: it is refused
// with a pointer to the resource metadata, discovers the authorization server from it,
// sends the person through sign-in and consent, swaps the code for a token, and lists
// the tools. Every step is one a real client (Claude Code, Cursor) takes, and each one
// once broke silently — discovery 404'd, sign-in forgot the authorization, and the
// consent page did not exist — so the whole path is pinned here, not piecewise.

const PORT = 3100;
const ORIGIN = `http://localhost:${PORT}`;
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT_URI = 'http://127.0.0.1:9999/callback';
const PROTOCOL_VERSION = '2026-07-28';

/** Register a public client directly. Real clients arrive through a Client ID Metadata
 * Document, which the server fetches over HTTPS from the client's own origin — nothing
 * a test can host. Registration is the server's business; the flow after it is ours. */
async function registerClient(clientId: string): Promise<void> {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://mocco:mocco@localhost:5432/mocco',
  });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO mocco_oauth_clients
         (client_id, name, redirect_uris, token_endpoint_auth_method, grant_types, response_types, require_pkce, scopes, application_type)
       VALUES ($1, 'E2E agent', ARRAY[$2], 'none', ARRAY['authorization_code','refresh_token'], ARRAY['code'], true,
               ARRAY['openid','profile','email','offline_access'], 'native')`,
      [clientId, REDIRECT_URI],
    );
    await db.query(
      `INSERT INTO mocco_oauth_resources (identifier, name) VALUES ($1, $1) ON CONFLICT (identifier) DO NOTHING`,
      [RESOURCE],
    );
    await db.query(`INSERT INTO mocco_oauth_client_resources (client_id, resource_id) VALUES ($1, $2)`, [
      clientId,
      RESOURCE,
    ]);
  } finally {
    await db.end();
  }
}

const mcpHeaders = (token: string, method: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': PROTOCOL_VERSION,
  'mcp-method': method,
});

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

test('an MCP client discovers the server, signs a person in, and lists the tools', async ({ page, request }) => {
  const email = `e2e-mcp-${randomUUID()}@example.com`;
  const password = 'e2e-password-123';
  const clientId = `e2e-agent-${randomUUID()}`;
  await registerClient(clientId);

  // --- An account exists, and its owner is signed out ---
  await page.goto('/auth/sign-up');
  await page.getByLabel('Name').fill('E2E Agent Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await page.goto('/auth/sign-out');
  await expect(page).toHaveURL(/\/$/);

  // --- Discovery: the 401 names the resource metadata, which names the issuer ---
  const refused = await request.post('/api/mcp', { data: {} });
  expect(refused.status()).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/u.exec(refused.headers()['www-authenticate'] ?? '')?.[1];
  expect(metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`);

  const resource = await request.get(metadataUrl ?? '');
  expect(resource.status()).toBe(200);
  const { authorization_servers: issuers } = (await resource.json()) as { authorization_servers: string[] };
  expect(issuers).toEqual([`${ORIGIN}/api/auth`]);

  const server = await request.get(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`);
  expect(server.status()).toBe(200);
  const { authorization_endpoint: authorizeUrl, token_endpoint: tokenUrl } = (await server.json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
  };

  // --- Authorization: sign-in resumes it, consent completes it ---
  // 64 hex characters: within PKCE's 43–128 and its unreserved alphabet.
  const verifier = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(authorizeUrl);
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile offline_access',
    state: 'e2e-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  };
  authorize.search = new URLSearchParams(params).toString();

  // The client's loopback listener: capture where the browser is finally sent.
  await page.route(`${REDIRECT_URI}**`, async route => {
    await route.fulfill({ status: 200, body: 'You can close this window.' });
  });
  const callback = page.waitForRequest(sent => sent.url().startsWith(REDIRECT_URI));

  await page.goto(authorize.href);
  await expect(page).toHaveURL(/\/auth\/sign-in\?/u);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/auth\/consent\?/u);
  await expect(page.getByRole('heading', { name: 'E2E agent wants to use Mocco as you' })).toBeVisible();
  await expect(page.getByText('Stay signed in without asking you again')).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  const callbackRequest = await callback;
  const redirected = new URL(callbackRequest.url());
  expect(redirected.searchParams.get('state')).toBe('e2e-state');
  const code = redirected.searchParams.get('code');
  expect(code).toBeTruthy();

  // --- Token, then a real call ---
  const tokenResponse = await request.post(tokenUrl, {
    form: {
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    },
  });
  expect(tokenResponse.status()).toBe(200);
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string };

  const listed = await request.post('/api/mcp', {
    headers: mcpHeaders(token, 'tools/list'),
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } },
  });
  expect(listed.status()).toBe(200);
  const { result } = (await listed.json()) as { result: { tools: { name: string }[] } };
  expect(result.tools.map(tool => tool.name)).toEqual(
    expect.arrayContaining(['mocco_runs_search', 'mocco_runs_get', 'mocco_approvals_search', 'mocco_approvals_get']),
  );
});
