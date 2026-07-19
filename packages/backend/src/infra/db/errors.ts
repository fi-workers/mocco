/** A row expected by a lookup was not found. A DB-layer error — a service catches
 * it at the repository boundary and maps it to a domain error class. */
export class EntityNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EntityNotFoundError';
  }
}
