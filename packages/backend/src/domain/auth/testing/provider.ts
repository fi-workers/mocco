// Test-only: the auth provider over an isolated (pglite) DB. Not imported by production
// code. It exists so a test says what it cares about — the database — rather than
// repeating the two values every auth test needs identically.
import { createProvider, type AuthOptions, type AdapterDb } from '@backend/domain/auth/provider';

/** Loopback, which is what a test is: the MCP resource identifier allows plain HTTP only
 * there, so this is the accurate value rather than a stand-in. */
export const TEST_MCP_RESOURCE = 'http://localhost/api/mcp';

export const TEST_AUTH_SECRET = 'test-secret-not-for-prod';

export function createTestProvider(db: AdapterDb, options: Partial<AuthOptions> = {}) {
  return createProvider(db, { secret: TEST_AUTH_SECRET, mcpResource: TEST_MCP_RESOURCE, ...options });
}
