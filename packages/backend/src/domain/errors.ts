// Shared bases for domain error families that share a transport mapping. Each
// domain keeps its own specific error classes (colocated in that domain's
// errors.ts) and extends a base here, so the tRPC layer maps a whole family in
// one place — via `instanceof` on the base — instead of per-procedure plumbing.

/** A referenced resource doesn't exist or isn't the caller's — maps to NOT_FOUND. */
export abstract class NotFoundError extends Error {}
