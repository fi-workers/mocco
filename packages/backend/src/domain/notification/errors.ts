/** A transient sender failure (5xx, timeout, network): thrown so the delivery job
 * retries with the queue's backoff. The message is the sender's redacted reason. */
export class TransientDeliveryError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = 'TransientDeliveryError';
  }
}
