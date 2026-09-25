import type { z } from 'zod';

/** A job kind and its payload schema — what an enqueuer needs. Handlers add `run`. */
export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  readonly kind: string;
  readonly payload: S;
}

/** What a handler learns about the run it is in. */
export interface JobContext {
  jobId: string;
  kind: string;
  /** 1 on the first attempt (attempts are counted at claim). */
  attempt: number;
  workspaceId: string | null;
  now: () => Date;
}

/** A registered handler. `run` resolves on success; it throws to fail (generic backoff)
 * or throws `RetryAt` to be retried at a specific time. Handlers must be idempotent:
 * a crashed or timed-out run is retried. */
export interface JobHandler<S extends z.ZodType = z.ZodType> extends JobDefinition<S> {
  // Method syntax on purpose: it keeps a handler for a concrete schema assignable to
  // the registry's JobHandler<ZodType>.
  run(payload: z.output<S>, ctx: JobContext): Promise<void>;
}

export function defineJob<S extends z.ZodType>(kind: string, payload: S): JobDefinition<S> {
  return { kind, payload };
}

export function handleJob<S extends z.ZodType>(
  job: JobDefinition<S>,
  run: (payload: z.output<S>, ctx: JobContext) => Promise<void>,
): JobHandler<S> {
  return { kind: job.kind, payload: job.payload, run };
}

/** Handlers by kind, built once in the composition root from each domain's handlers. */
export class JobHandlerRegistry {
  private readonly byKind: ReadonlyMap<string, JobHandler>;

  constructor(handlers: readonly JobHandler[]) {
    const duplicate = handlers.find(
      (handler, index) => handlers.findIndex(other => other.kind === handler.kind) !== index,
    );
    if (duplicate) {
      throw new Error(`two job handlers registered for kind "${duplicate.kind}"`);
    }
    this.byKind = new Map(handlers.map(handler => [handler.kind, handler]));
  }

  get(kind: string): JobHandler | undefined {
    return this.byKind.get(kind);
  }
}
