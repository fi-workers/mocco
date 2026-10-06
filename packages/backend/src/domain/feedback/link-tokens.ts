// The signed links of feedback mail (#174), like the status subscribers' (#156): a token names
// one purpose, one project and one end user (and, to unsubscribe, one post), signed with a key
// derived from the server secret. Nothing is stored; a token for one purpose never passes for
// another, and an edited one fails the signature.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const FeedbackLinkPurposes = { identify: 'identify', unsubscribe: 'unsubscribe' } as const;
export type FeedbackLinkPurpose = (typeof FeedbackLinkPurposes)[keyof typeof FeedbackLinkPurposes];

/** An email confirmation link works for a day; an unsubscribe link has no expiry (it is in every mail). */
export const IDENTIFY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const claimsSchema = z.object({
  k: z.enum([FeedbackLinkPurposes.identify, FeedbackLinkPurposes.unsubscribe]),
  w: z.uuid(),
  p: z.uuid(),
  u: z.string().min(1).max(255),
  /** The post, for an unsubscribe link. */
  o: z.uuid().optional(),
  /** Expiry in unix seconds; 0 for none. */
  x: z.int().min(0),
});

export interface FeedbackLinkClaims {
  workspaceId: string;
  projectId: string;
  endUserId: string;
  postId?: string;
}

export class FeedbackLinkTokens {
  constructor(private readonly key: string) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(`feedback-link.${payload}`).digest('base64url');
  }

  /** `<base64url claims>.<signature>` */
  issue(purpose: FeedbackLinkPurpose, claims: FeedbackLinkClaims, now: Date): string {
    const expires =
      purpose === FeedbackLinkPurposes.identify ? Math.floor((now.getTime() + IDENTIFY_LINK_TTL_MS) / 1000) : 0;
    const payload = Buffer.from(
      JSON.stringify({
        k: purpose,
        w: claims.workspaceId,
        p: claims.projectId,
        u: claims.endUserId,
        ...(claims.postId !== undefined && { o: claims.postId }),
        x: expires,
      }),
      // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array#toBase64
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** The claims of a valid, unexpired token of `purpose`; null otherwise. */
  // eslint-disable-next-line sonarjs/function-return-type -- null is the "not valid" answer
  verify(purpose: FeedbackLinkPurpose, token: string, now: Date): FeedbackLinkClaims | null {
    // eslint-disable-next-line sonarjs/null-dereference -- token is a string
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [payload = '', signature = ''] = parts;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    let json: unknown;
    try {
      // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array.fromBase64
      json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const claims = claimsSchema.safeParse(json);
    if (!claims.success || claims.data.k !== purpose) {
      return null;
    }
    const { w, p, u, o, x } = claims.data;
    if (x !== 0 && x * 1000 <= now.getTime()) {
      return null;
    }
    return { workspaceId: w, projectId: p, endUserId: u, ...(o !== undefined && { postId: o }) };
  }
}
