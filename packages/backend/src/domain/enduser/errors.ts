// Errors of the end-user identity layer (platform foundations F2).

/** Why an end-user token was refused. */
export const EndUserTokenRefusals = {
  /** Not a JWT, not HS256, missing `sub` or `exp`, or not signed with the project's secret
   * (a token another project signed reads exactly like this). */
  invalid: 'invalid',
  expired: 'expired',
  /** `exp` more than an hour (plus the skew) ahead: a token must be short-lived. */
  tooLong: 'too_long',
  /** The project has no identity secret yet (it is minted when the messenger is set up). */
  noSecret: 'no_secret',
} as const;
export type EndUserTokenRefusal = (typeof EndUserTokenRefusals)[keyof typeof EndUserTokenRefusals];

/** An end-user token that doesn't prove who the end user is. The transport answers 401. */
export class EndUserTokenRejectedError extends Error {
  constructor(
    readonly refusal: EndUserTokenRefusal,
    options?: ErrorOptions,
  ) {
    super(`The end-user token was refused: ${refusal}`, options);
    this.name = 'EndUserTokenRejectedError';
  }
}
