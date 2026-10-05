// The embedded probe (ADR 0027 §6, #150): with STATUS_PROBE_EMBEDDED=true a single-node
// self-hosted server runs @mocco/probe's own loop in-process as the shared `embedded`
// location, so a one-box install has monitors without running a second process. It is the
// same agent as the `mocco-probe` bin; only its API differs: instead of HTTP with a location
// token, it calls ProbeService directly as that location.
//
// It starts with the first job tick after the server boots (the tick a self-host cron already
// calls every minute), once per process. It never runs on Vercel, where a function's process
// is frozen between requests and a background loop would stall or run in many instances.
import { LocationKinds } from '@mocco/common/status';
import { createAgent, PROBE_VERSION, type AgentTiming, type Logger, type ProbeApi } from '@mocco/probe/create-agent';

import { getStatusDomain } from '@backend/domain/status/instance';
import { getEnv } from '@backend/infra/config/env';

import type { LocationService } from '@backend/domain/status/LocationService';
import type { ProbeLocation, ProbeService } from '@backend/domain/status/ProbeService';

/** What the embedded probe reports as its agent version. */
export const EMBEDDED_AGENT_VERSION = `embedded-${PROBE_VERSION}`;

/** The probe protocol, in-process: the same calls the `/v1/probe` routes make, as `location`. */
export function inProcessProbeApi(
  probes: Pick<ProbeService, 'lease' | 'report' | 'heartbeat'>,
  location: ProbeLocation,
  agentVersion: string,
): ProbeApi {
  return {
    lease: async capacity => {
      const { leases, pollAfterMs } = await probes.lease(location, { agentVersion, capacity });
      return { leases, skipped: 0, pollAfterMs };
    },
    report: async results => await probes.report(location, results),
    // The service records only that the location was seen; it doesn't keep the in-flight count.
    heartbeat: async () => {
      await probes.heartbeat(location, { agentVersion });
    },
  };
}

export interface EmbeddedProbeDeps {
  probes: Pick<ProbeService, 'lease' | 'report' | 'heartbeat'>;
  locations: Pick<LocationService, 'ensureEmbedded'>;
  concurrency: number;
  log: Logger;
  timing?: Partial<AgentTiming>;
}

/**
 * Runs the embedded location's loop until `signal` aborts, then resolves once the agent has
 * stopped (running checks finished, their results reported). Returns at once when the
 * embedded location was disabled.
 */
export async function runEmbeddedProbe(deps: EmbeddedProbeDeps, signal: AbortSignal): Promise<void> {
  const row = await deps.locations.ensureEmbedded();
  if (row.kind !== LocationKinds.embedded) {
    deps.log.warn(`The shared location "${row.code}" is not the embedded one; the embedded probe stays off`);
    return;
  }
  if (row.disabledAt !== null) {
    deps.log.warn('The embedded location is disabled; the embedded probe stays off');
    return;
  }
  const location: ProbeLocation = { id: row.id, workspaceId: null, kind: row.kind, code: row.code };
  const agent = createAgent({
    api: inProcessProbeApi(deps.probes, location, EMBEDDED_AGENT_VERSION),
    agentVersion: EMBEDDED_AGENT_VERSION,
    concurrency: deps.concurrency,
    // A one-box install checks its own network, like a private location.
    isHosted: false,
    log: deps.log,
    ...(deps.timing !== undefined && { timing: deps.timing }),
  });
  deps.log.info('Embedded probe started', { locationId: row.id });
  await agent.run(signal);
  deps.log.info('Embedded probe stopped');
}

const log: Logger = {
  info: (message, fields) => {
    console.warn(`[status] ${message}`, fields ?? '');
  },
  warn: (message, fields) => {
    console.warn(`[status] ${message}`, fields ?? '');
  },
};

/** Why `ensureEmbeddedProbe` did or didn't start the loop. */
export const EmbeddedProbeStates = {
  off: 'off',
  refusedOnVercel: 'refused_on_vercel',
  running: 'running',
} as const;
export type EmbeddedProbeState = (typeof EmbeddedProbeStates)[keyof typeof EmbeddedProbeStates];

// One per process. Kept on globalThis so a module reloaded by the dev server's HMR finds the
// loop the first copy started instead of starting another.
const KEY = Symbol.for('mocco.status.embeddedProbe');
interface ProcessSlot {
  [KEY]?: { state: EmbeddedProbeState; stop: () => void; done: Promise<void> };
}
const slot = globalThis as ProcessSlot;

/**
 * Starts the embedded probe in this process if STATUS_PROBE_EMBEDDED asks for it and it isn't
 * running yet. Synchronous up to the start, so concurrent ticks can't start two loops. On
 * Vercel it refuses (once, with a warning) and never starts.
 */
export function ensureEmbeddedProbe(): EmbeddedProbeState {
  const existing = slot[KEY];
  if (existing !== undefined) {
    return existing.state;
  }
  const env = getEnv();
  if (!env.STATUS_PROBE_EMBEDDED) {
    return EmbeddedProbeStates.off;
  }
  if (env.VERCEL_ENV !== undefined) {
    log.warn('STATUS_PROBE_EMBEDDED is ignored on Vercel; run @mocco/probe at a location instead');
    slot[KEY] = { state: EmbeddedProbeStates.refusedOnVercel, stop: () => undefined, done: Promise.resolve() };
    return EmbeddedProbeStates.refusedOnVercel;
  }
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  const { statusProbes, statusLocations } = getStatusDomain();
  const run = async () => {
    try {
      await runEmbeddedProbe(
        { probes: statusProbes, locations: statusLocations, concurrency: env.STATUS_PROBE_CONCURRENCY, log },
        controller.signal,
      );
    } catch (error) {
      // Not restarted in this process: a failure here is a bug or a lost database.
      console.error('[status] The embedded probe stopped on an error', error);
    }
  };
  const done = run();
  slot[KEY] = { state: EmbeddedProbeStates.running, stop, done };
  // Stop leasing when the server is asked to stop; the server's own handler then exits.
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return EmbeddedProbeStates.running;
}
