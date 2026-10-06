// The signed links in subscriber mail (#156). A token names one subscriber and one purpose,
// confirming a sign-up or unsubscribing, and is signed with a key derived from the server
// secret: nothing is stored, a token for one purpose never passes for the other, and a token
// whose subscriber, purpose or expiry was edited fails the signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SubscriberTokenPurposes = { confirm: 'confirm', unsubscribe: 'unsubscribe' } as const;
export type SubscriberTokenPurpose = (typeof SubscriberTokenPurposes)[keyof typeof SubscriberTokenPurposes];

/** A confirmation link works for a week; an unsubscribe link has no expiry (it is in every mail). */
export const CONFIRM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

export class SubscriberTokens {
  constructor(private readonly key: string) {}

  private sign(purpose: SubscriberTokenPurpose, subscriberId: string, expires: string): string {
    return createHmac('sha256', this.key)
      .update(`status-subscriber.${purpose}.${subscriberId}.${expires}`)
      .digest('base64url');
  }

  /** `<subscriber id>.<expiry in unix seconds, 0 for none>.<signature>` */
  issue(purpose: SubscriberTokenPurpose, subscriberId: string, now: Date): string {
    const expires =
      purpose === SubscriberTokenPurposes.confirm
        ? String(Math.floor((now.getTime() + CONFIRM_TOKEN_TTL_MS) / 1000))
        : '0';
    return `${subscriberId}.${expires}.${this.sign(purpose, subscriberId, expires)}`;
  }

  /** The subscriber a valid, unexpired token of `purpose` names; null otherwise. */
  verify(purpose: SubscriberTokenPurpose, token: string, now: Date): string | null {
    // eslint-disable-next-line sonarjs/null-dereference -- token is a string
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [subscriberId = '', expires = '', signature = ''] = parts;
    if (!UUID.test(subscriberId) || !/^\d{1,12}$/u.test(expires)) {
      return null;
    }
    const expected = Buffer.from(this.sign(purpose, subscriberId, expires));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    const expiresAt = Number(expires) * 1000;
    return expiresAt === 0 || expiresAt > now.getTime() ? subscriberId : null;
  }
}
