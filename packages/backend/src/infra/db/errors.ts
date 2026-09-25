/** A row expected by a lookup was not found. A DB-layer error — a service catches
 * it at the repository boundary and maps it to a domain error class. */
export class EntityNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EntityNotFoundError';
  }
}

/** A write hit a unique constraint. A DB-layer error like EntityNotFoundError: the repo
 * throws it (naming the constraint) and the service maps it to a domain error. */
export class UniqueConstraintError extends Error {
  constructor(
    readonly constraint: string,
    options?: ErrorOptions,
  ) {
    super(`Unique constraint ${constraint} was violated`, options);
    this.name = 'UniqueConstraintError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';

/** Re-throw a Postgres unique violation (anywhere in the cause chain — drizzle wraps the
 * driver error) as UniqueConstraintError; re-throw anything else unchanged. Works for
 * node-postgres and pglite, which both expose `code` and `constraint` on the driver error. */
export function rethrowUniqueViolation(error: unknown): never {
  let current: unknown = error;
  while (current instanceof Error) {
    const { code, constraint } = current as Error & { code?: unknown; constraint?: unknown };
    if (code === PG_UNIQUE_VIOLATION && typeof constraint === 'string') {
      throw new UniqueConstraintError(constraint, { cause: error });
    }
    current = current.cause;
  }
  throw error;
}
