#!/usr/bin/env node
// The `mocco-probe` executable: one location's agent. Configured by the environment (see
// config.ts), logs one JSON line per event, and stops cleanly on SIGTERM or SIGINT.
import { ProbeClient } from './client';
import { readConfig } from './config';
import { createAgent, PROBE_VERSION, type Logger } from './create-agent';
import { ProbeAuthError } from './errors';

const write = (level: string, message: string, fields?: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
};

const log: Logger = {
  info: (message, fields) => {
    write('info', message, fields);
  },
  warn: (message, fields) => {
    write('warn', message, fields);
  },
};

async function main(): Promise<number> {
  const { config, problems } = readConfig(process.env);
  if (config === undefined) {
    write('error', 'Invalid configuration', { problems });
    return 2;
  }
  const agentVersion = PROBE_VERSION;
  const agent = createAgent({
    api: new ProbeClient({ baseUrl: config.MOCCO_URL, token: config.MOCCO_PROBE_TOKEN, agentVersion }),
    agentVersion,
    concurrency: config.MOCCO_PROBE_CONCURRENCY,
    isHosted: config.MOCCO_PROBE_HOSTED,
    log,
  });

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    log.info('Stopping', { signal });
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  log.info('Probe started', {
    agentVersion,
    mocco: config.MOCCO_URL,
    concurrency: config.MOCCO_PROBE_CONCURRENCY,
    hosted: config.MOCCO_PROBE_HOSTED,
  });
  try {
    await agent.run(controller.signal);
  } catch (error) {
    if (error instanceof ProbeAuthError) {
      write('error', error.message);
      return 1;
    }
    throw error;
  }
  log.info('Probe stopped');
  return 0;
}

process.exitCode = await main();
