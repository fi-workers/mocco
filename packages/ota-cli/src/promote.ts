// Promotion from the CLI: wait until Mocco has verified a release's assets, then point
// an unprotected channel at it — with a secret key (`mocco-ota promote`) or with the
// upload session that published it (`mocco-ota publish --channel`).
import { MoccoApi } from './api';
import { CliError } from './errors';

import type { PromotionResult } from '@mocco/common/ota-hosting';

export interface WaitOptions {
  /** How long to wait for `ready`. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface PromoteOptions extends WaitOptions {
  apiBase: string;
  appId: string;
  apiKey: string;
  releaseId: string;
  channel: string;
  fetch?: typeof fetch;
}

const sleepFor = async (ms: number) => {
  await new Promise(resolve => {
    setTimeout(resolve, ms);
  });
};

/** Poll `status` until the release is ready; a failed release or a timeout is an error. */
async function waitUntilReady(
  releaseId: string,
  status: () => Promise<{ status: string }>,
  options: WaitOptions,
): Promise<void> {
  const sleep = options.sleep ?? sleepFor;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const poll = async (): Promise<void> => {
    const current = await status();
    if (current.status === 'ready') {
      return;
    }
    if (current.status !== 'verifying') {
      throw new CliError(`Release ${releaseId} is ${current.status}; it can't be promoted`);
    }
    if (Date.now() > deadline) {
      throw new CliError(`Release ${releaseId} is still verifying; promote it later with mocco-ota promote`);
    }
    await sleep(options.pollMs ?? 2000);
    await poll();
  };
  await poll();
}

function logResult(result: PromotionResult, log: (line: string) => void): PromotionResult {
  log(
    result.changed
      ? `Promoted release ${result.releaseId} to ${result.channel} (${result.platforms.join(', ')}).`
      : `${result.channel} already serves release ${result.releaseId}.`,
  );
  return result;
}

/** `mocco-ota promote`: with a secret API key. */
export async function promote(options: PromoteOptions): Promise<PromotionResult> {
  const api = new MoccoApi(options.apiBase, options.fetch);
  await waitUntilReady(
    options.releaseId,
    async () => await api.releaseStatus(options.appId, options.releaseId, options.apiKey),
    options,
  );
  const result = await api.promote(options.appId, options.releaseId, options.channel, options.apiKey);
  return logResult(result, options.log ?? (() => {}));
}

/** After `publish --channel`: with the upload session (an OIDC session may promote only
 * to its trust policy's channels). */
export async function promoteWithSession(
  api: MoccoApi,
  input: { session: string; releaseId: string; channel: string },
  options: WaitOptions = {},
): Promise<PromotionResult> {
  await waitUntilReady(
    input.releaseId,
    async () => await api.sessionReleaseStatus(input.session, input.releaseId),
    options,
  );
  const result = await api.sessionPromote(input.session, input.releaseId, input.channel);
  return logResult(result, options.log ?? (() => {}));
}
