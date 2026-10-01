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
  /** Below 100 starts a staged rollout to that share of devices. */
  rolloutPercent?: number;
  /** On a protected channel, wait for the approval request to be decided. */
  isWaitingForApproval?: boolean;
  /** How long to wait for a decision. */
  approvalTimeoutMs?: number;
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
  if (result.outcome === 'pending_approval') {
    log(`${result.channel} is protected: approval request ${result.requestId ?? ''} is waiting in the Mocco console.`);
    return result;
  }
  const verb = result.kind === 'rollout' ? 'Started rolling out' : 'Promoted';
  log(
    result.changed
      ? `${verb} release ${result.releaseId ?? ''} to ${result.channel} (${result.platforms.join(', ')}).`
      : `${result.channel} already serves release ${result.releaseId ?? ''}.`,
  );
  return result;
}

/** Poll an approval request until it is decided: approved resolves, anything else throws. */
async function waitForDecision(
  state: () => Promise<{ state: string }>,
  options: WaitOptions & { approvalTimeoutMs?: number },
): Promise<void> {
  const sleep = options.sleep ?? sleepFor;
  const deadline = Date.now() + (options.approvalTimeoutMs ?? 60 * 60 * 1000);
  const poll = async (): Promise<void> => {
    const current = await state();
    if (current.state === 'approved') {
      (options.log ?? (() => {}))('Approved: the channel now serves the release.');
      return;
    }
    if (current.state !== 'pending') {
      throw new CliError(`The promotion was ${current.state}`);
    }
    if (Date.now() > deadline) {
      throw new CliError('Still waiting for approval; the request stays open in the Mocco console');
    }
    await sleep(options.pollMs ?? 5000);
    await poll();
  };
  await poll();
}

/** `mocco-ota promote`: with a secret API key. */
export async function promote(options: PromoteOptions): Promise<PromotionResult> {
  const api = new MoccoApi(options.apiBase, options.fetch);
  await waitUntilReady(
    options.releaseId,
    async () => await api.releaseStatus(options.appId, options.releaseId, options.apiKey),
    options,
  );
  const result = logResult(
    await api.promote(
      options.appId,
      options.releaseId,
      { channel: options.channel, rolloutPercent: options.rolloutPercent ?? 100 },
      options.apiKey,
    ),
    options.log ?? (() => {}),
  );
  if (result.outcome === 'pending_approval' && options.isWaitingForApproval === true && result.requestId !== null) {
    const path = `/ota/apps/${options.appId}/promotions/${result.requestId}`;
    await waitForDecision(async () => await api.promotionState(path, options.apiKey), options);
  }
  return result;
}

/** After `publish --channel`: with the upload session (an OIDC session may promote only
 * to its trust policy's channels). */
export async function promoteWithSession(
  api: MoccoApi,
  input: { session: string; releaseId: string; channel: string; rolloutPercent?: number },
  options: WaitOptions & { isWaitingForApproval?: boolean; approvalTimeoutMs?: number } = {},
): Promise<PromotionResult> {
  await waitUntilReady(
    input.releaseId,
    async () => await api.sessionReleaseStatus(input.session, input.releaseId),
    options,
  );
  const result = logResult(
    await api.sessionPromote(input.session, input.releaseId, {
      channel: input.channel,
      rolloutPercent: input.rolloutPercent ?? 100,
    }),
    options.log ?? (() => {}),
  );
  if (result.outcome === 'pending_approval' && options.isWaitingForApproval === true && result.requestId !== null) {
    const path = `/ota/uploads/${input.releaseId}/promotions/${result.requestId}`;
    await waitForDecision(async () => await api.promotionState(path, input.session), options);
  }
  return result;
}
