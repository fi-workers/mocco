// The JWT leaf of end-user identity (platform foundations F2): verify an HS256 token that the
// project's server signed with its identity secret.
import { errors, jwtVerify } from 'jose';

/** Clock skew allowed between the customer's server and Mocco. */
export const END_USER_TOKEN_CLOCK_SKEW_SECONDS = 60;

export type Hs256Verdict =
  { ok: true; payload: Record<string, unknown> } | { ok: false; reason: 'expired' | 'invalid' };

/** The token's claims when `secret` signed it with HS256 and it hasn't expired (within the
 * allowed skew). `exp` and `sub` are required. */
export async function verifyHs256(token: string, secret: string, now: Date): Promise<Hs256Verdict> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      clockTolerance: END_USER_TOKEN_CLOCK_SKEW_SECONDS,
      currentDate: now,
      requiredClaims: ['exp', 'sub'],
    });
    return { ok: true, payload };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: 'expired' };
    }
    if (error instanceof errors.JOSEError) {
      return { ok: false, reason: 'invalid' };
    }
    throw error;
  }
}
