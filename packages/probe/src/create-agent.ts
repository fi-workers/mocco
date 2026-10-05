// The agent with its real checks, for any host: the `mocco-probe` bin (over HTTP to Mocco) and
// a Mocco server running the embedded probe (over its own ProbeService, no HTTP). Both get the
// same loop and the same checks; only the `api` differs.
import packageJson from '../package.json' with { type: 'json' };

import { addressPolicyFor } from './address-policy';
import { ProbeAgent, type AgentTiming, type Logger } from './agent';
import { systemLookup } from './resolve';
import { createRunCheck } from './run-check';

import type { ProbeApi } from './client';

export type { AgentTiming, Logger } from './agent';
export type { LeaseBatch, ProbeApi, ResultsAnswer } from './client';

/** This package's version, as agents report it. */
export const PROBE_VERSION: string = packageJson.version;

export interface CreateAgentOptions {
  api: ProbeApi;
  /** Reported to Mocco and sent in `User-Agent`. */
  agentVersion: string;
  concurrency: number;
  /** Refuse private, loopback, link-local and metadata targets (Mocco's hosted fleet). */
  isHosted: boolean;
  log: Logger;
  timing?: Partial<AgentTiming>;
}

export function createAgent(options: CreateAgentOptions): ProbeAgent {
  return new ProbeAgent({
    api: options.api,
    runCheck: createRunCheck({
      resolver: { lookup: systemLookup, policy: addressPolicyFor(options.isHosted) },
      userAgent: `mocco-probe/${options.agentVersion} (+https://mocco.dev)`,
      now: () => new Date(),
    }),
    concurrency: options.concurrency,
    log: options.log,
    ...(options.timing !== undefined && { timing: options.timing }),
  });
}
