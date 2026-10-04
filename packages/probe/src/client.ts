// The probe protocol's client (`/api/ext/v1/probe/*`, ADR 0027): the location token as the
// bearer, the request and answer shapes from @mocco/common so the agent and the routes can't
// drift apart.
import {
  probeLeaseResponseSchema,
  probeLeaseSchema,
  probeResultsResponseSchema,
  type ProbeLeaseDto,
  type ProbeResult,
} from '@mocco/common/status';
import { z } from 'zod';

import { ProbeAuthError, ProbeRequestError } from './errors';

export interface LeaseBatch {
  leases: ProbeLeaseDto[];
  /** Leases this agent can't run (a monitor kind newer than the agent); they go unreported. */
  skipped: number;
  pollAfterMs: number;
}

export type ResultsAnswer = z.infer<typeof probeResultsResponseSchema>;

/** What the agent loop needs from Mocco. */
export interface ProbeApi {
  lease: (capacity: number) => Promise<LeaseBatch>;
  report: (results: ProbeResult[]) => Promise<ResultsAnswer>;
  heartbeat: (inflight: number) => Promise<void>;
}

const leaseEnvelopeSchema = z.object({
  leases: z.array(z.unknown()),
  pollAfterMs: probeLeaseResponseSchema.shape.pollAfterMs,
});

const REQUEST_TIMEOUT_MS = 15_000;

export interface ProbeClientOptions {
  /** Mocco's origin, e.g. `https://www.mocco.work`. */
  baseUrl: string;
  token: string;
  agentVersion: string;
}

export class ProbeClient implements ProbeApi {
  private readonly endpoint: string;

  constructor(private readonly options: ProbeClientOptions) {
    this.endpoint = new URL('/api/ext/v1/probe', options.baseUrl).href;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          'user-agent': `mocco-probe/${this.options.agentVersion}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProbeRequestError(path, undefined, error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) {
      throw new ProbeAuthError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProbeRequestError(path, response.status, `HTTP ${response.status}`);
    }
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  }

  async lease(capacity: number): Promise<LeaseBatch> {
    const body = await this.post('/lease', { agentVersion: this.options.agentVersion, capacity });
    const envelope = leaseEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new ProbeRequestError('/lease', 200, 'unexpected answer');
    }
    const parsed = envelope.data.leases.map(lease => probeLeaseSchema.safeParse(lease));
    const leases = parsed.flatMap(result => (result.success ? [result.data] : []));
    return { leases, skipped: parsed.length - leases.length, pollAfterMs: envelope.data.pollAfterMs };
  }

  async report(results: ProbeResult[]): Promise<ResultsAnswer> {
    const answer = probeResultsResponseSchema.safeParse(await this.post('/results', { results }));
    if (!answer.success) {
      throw new ProbeRequestError('/results', 202, 'unexpected answer');
    }
    return answer.data;
  }

  async heartbeat(inflight: number): Promise<void> {
    await this.post('/heartbeat', { agentVersion: this.options.agentVersion, inflight });
  }
}
