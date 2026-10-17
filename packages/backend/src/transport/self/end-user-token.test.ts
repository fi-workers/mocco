import { describe, expect, it } from 'vitest';

import { EndUserTokenService } from '@backend/domain/enduser/EndUserTokenService';
import { EndUserTokenRefusals, EndUserTokenRejectedError } from '@backend/domain/enduser/errors';
import { verifyHs256 } from '@backend/domain/enduser/jwt';
import { selfEndUserToken } from '@backend/transport/self/end-user-token';

import type { SelfEndUserTokenDeps } from '@backend/transport/self/end-user-token';

const SECRET = 'mocco-self-identity-secret-for-tests';
const NOW = new Date('2026-10-17T10:00:00.500Z');
const USER_ID = '4f0c1a52-2b8e-4d2e-9a51-0d6f3c1e7b90';
const SCOPE = { workspaceId: 'w', projectId: 'p' };

const signedIn: SelfEndUserTokenDeps['sessionOf'] = async () =>
  await Promise.resolve({ user: { id: USER_ID } } as never);

const deps = (overrides: Partial<SelfEndUserTokenDeps> = {}): SelfEndUserTokenDeps => ({
  sessionOf: signedIn,
  identitySecret: SECRET,
  now: () => NOW,
  ...overrides,
});

/** Mocco's own project, verifying tokens as the /v1 routes do. */
const projectAt = (now: Date, secret = SECRET) =>
  new EndUserTokenService({ secrets: { identitySecretOf: async () => await Promise.resolve(secret) }, now: () => now });

/** The token's claims, checked with the secret it should carry. */
const claimsOf = async (token: string): Promise<Record<string, unknown>> => {
  const verdict = await verifyHs256(token, SECRET, NOW);
  return verdict.ok ? verdict.payload : {};
};

describe('selfEndUserToken', () => {
  it('refuses a caller without a console session', async () => {
    const answer = await selfEndUserToken(deps({ sessionOf: async () => await Promise.resolve(null) }), new Headers());
    expect(answer).toEqual({ status: 401, body: { error: 'Sign in first' } });
  });

  it('answers 404 without the identity secret, before reading the session', async () => {
    let wasAsked = false;
    const answer = await selfEndUserToken(
      deps({
        identitySecret: undefined,
        sessionOf: async () => {
          wasAsked = true;
          return await Promise.resolve(null);
        },
      }),
      new Headers(),
    );
    expect([answer.status, wasAsked]).toEqual([404, false]);
  });

  it("signs the console user's Mocco id as sub, for ten minutes, and the project accepts it", async () => {
    const answer = await selfEndUserToken(deps(), new Headers({ cookie: 'session=1' }));
    if (answer.status !== 200) {
      throw new Error(`expected 200, got ${String(answer.status)}`);
    }
    const { token, expiresAt } = answer.body;
    const claims = await claimsOf(token);
    expect({ sub: claims.sub, ttl: Number(claims.exp) - Number(claims.iat), expiresAt }).toEqual({
      sub: USER_ID,
      ttl: 600,
      expiresAt: '2026-10-17T10:10:00.000Z',
    });
    await expect(projectAt(NOW).verify(SCOPE, token)).resolves.toEqual({ endUserId: USER_ID });
  });

  it('gives a token that expires: refused eleven minutes on, and under another secret', async () => {
    const answer = await selfEndUserToken(deps(), new Headers());
    const token = answer.status === 200 ? answer.body.token : '';
    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    await expect(projectAt(later).verify(SCOPE, token)).rejects.toEqual(
      new EndUserTokenRejectedError(EndUserTokenRefusals.expired),
    );
    await expect(projectAt(NOW, 'another-project-secret').verify(SCOPE, token)).rejects.toEqual(
      new EndUserTokenRejectedError(EndUserTokenRefusals.invalid),
    );
  });
});
