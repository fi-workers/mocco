// Test-only: the auth provider over an isolated (pglite) DB. Not imported by production
// code. It exists so a test says what it cares about — the database — rather than
// repeating the two values every auth test needs identically.
import { createProvider, type AuthOptions, type AdapterDb } from '@backend/domain/auth/provider';

/** Loopback, which is what a test is: the MCP resource identifier allows plain HTTP only
 * there, so these are accurate values rather than stand-ins. The base URL has to be set
 * too — the authorization server resolves its login and consent paths against it, and
 * without one they are not URLs at all. */
export const TEST_BASE_URL = 'http://localhost';
export const TEST_MCP_RESOURCE = `${TEST_BASE_URL}/api/mcp`;

export const TEST_AUTH_SECRET = 'test-secret-not-for-prod';

/**
 * Awaits the provider's initialisation before handing it over. The authorization server
 * seeds its resource row on init, so a provider built and left un-awaited keeps writing
 * after the test body ends — and the DB is closed by then, which surfaces as an unhandled
 * rejection rather than a failure. Awaiting here also means a test observes a provider
 * that is actually ready.
 */
export async function createTestProvider(db: AdapterDb, options: Partial<AuthOptions> = {}) {
  const provider = createProvider(db, {
    secret: TEST_AUTH_SECRET,
    baseUrl: TEST_BASE_URL,
    mcpResource: TEST_MCP_RESOURCE,
    ...options,
  });
  await provider.$context;
  return provider;
}
