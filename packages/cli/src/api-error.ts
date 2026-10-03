/** A refusal from Mocco; the message carries the problem's `detail`. */
export class MoccoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MoccoApiError';
  }
}
