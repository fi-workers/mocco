// `mocco-ota promote`, and `publish --channel`: wait until Mocco has verified the
// release's assets, then point an unprotected channel at it.
import { MoccoApi } from './api';
import { CliError } from './errors';

import type { PromotionResult } from '@mocco/common/ota-hosting';

export interface PromoteOptions {
  apiBase: string;
  appId: string;
  apiKey: string;
  releaseId: string;
  channel: string;
  /** How long to wait for `ready`. */
  timeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = async (ms: number) => {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
};

/** Poll until the release is ready; a failed release or a timeout is an error. */
async function waitUntilReady(api: MoccoApi, options: PromoteOptions): Promise<void> {
  const sleep = options.sleep ?? sleepFor;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const poll = async (): Promise<void> => {
    const { status } = await api.releaseStatus(options.appId, options.releaseId, options.apiKey);
    if (status === 'ready') {
      return;
    }
    if (status !== 'verifying') {
      throw new CliError(`Release ${options.releaseId} is ${status}; it can't be promoted`);
    }
    if (Date.now() > deadline) {
      throw new CliError(`Release ${options.releaseId} is still verifying; promote it later with mocco-ota promote`);
    }
    await sleep(options.pollMs ?? 2000);
    await poll();
  };
  await poll();
}

export async function promote(options: PromoteOptions): Promise<PromotionResult> {
  const log = options.log ?? (() => {});
  const api = new MoccoApi(options.apiBase, options.fetch);
  await waitUntilReady(api, options);
  const result = await api.promote(options.appId, options.releaseId, options.channel, options.apiKey);
  log(
    result.changed
      ? `Promoted release ${result.releaseId} to ${result.channel} (${result.platforms.join(', ')}).`
      : `${result.channel} already serves release ${result.releaseId}.`,
  );
  return result;
}
