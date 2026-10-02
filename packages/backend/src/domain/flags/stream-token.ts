// Short-lived tokens for the flags change stream (`GET /v1/flags/stream?token=`). A
// browser's EventSource can't send an Authorization header, so the OFREP bulk response
// advertises a stream URL carrying one of these: it names only an environment and an
// expiry, signed with a key derived from the server secret, and grants nothing but
// "tell me when this environment changes".
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a stream token is valid; the stream itself closes sooner. */
export const STREAM_TOKEN_TTL_MS = 60 * 60 * 1000;

export class StreamTokens {
  constructor(private readonly key: string) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue(workspaceId: string, environmentId: string, now: Date = new Date()): string {
    const payload = `${workspaceId}.${environmentId}.${Math.floor((now.getTime() + STREAM_TOKEN_TTL_MS) / 1000)}`;
    return `${payload}.${this.sign(payload)}`;
  }

  /** The environment a valid, unexpired token names; null otherwise. */
  // eslint-disable-next-line sonarjs/function-return-type -- null is the "not a valid token" answer
  verify(token: string, now: Date = new Date()): { workspaceId: string; environmentId: string } | null {
    // eslint-disable-next-line sonarjs/null-dereference -- token is a string
    const parts = token.split('.');
    if (parts.length !== 4) {
      return null;
    }
    const [workspaceId = '', environmentId = '', expires = '', signature = ''] = parts;
    const expected = Buffer.from(this.sign(`${workspaceId}.${environmentId}.${expires}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    return Number(expires) * 1000 > now.getTime() ? { workspaceId, environmentId } : null;
  }
}
