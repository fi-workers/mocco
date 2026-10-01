// The Mocco /v1 OTA upload endpoints, for the CLI. Refusals are problem+json whose
// `detail` says what to fix; MoccoApiError carries it as the message.
import { MoccoApiError } from './api-error';

import type { FinalizeRequest, PromotionResult, UploadRequest, UploadResponse } from '@mocco/common/ota-hosting';

interface Problem {
  title?: string;
  detail?: string;
}

async function errorOf(response: Response, what: string): Promise<MoccoApiError> {
  const text = await response.text();
  let problem: Problem = {};
  try {
    problem = JSON.parse(text) as Problem;
  } catch {
    // Not problem+json (a proxy page, say): report the status alone.
  }
  const reason = problem.detail ?? problem.title ?? `HTTP ${response.status}`;
  return new MoccoApiError(response.status, `${what} failed (${response.status}): ${reason}`);
}

export interface FinalizeResult {
  releaseId: string;
  status: string;
  updates: Record<string, string>;
}

export class MoccoApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async postJson<T>(path: string, token: string, body: unknown, what: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await errorOf(response, what);
    }
    return (await response.json()) as T;
  }

  /** A release's status (`verifying` until Mocco has re-hashed its assets, then `ready`). */
  async releaseStatus(appId: string, releaseId: string, apiKey: string): Promise<{ id: string; status: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/ota/apps/${appId}/releases/${releaseId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw await errorOf(response, 'Reading the release');
    }
    return (await response.json()) as { id: string; status: string };
  }

  async promote(
    appId: string,
    releaseId: string,
    input: { channel: string; rolloutPercent: number },
    apiKey: string,
  ): Promise<PromotionResult> {
    return await this.postJson<PromotionResult>(
      `/ota/apps/${appId}/releases/${releaseId}/promotions`,
      apiKey,
      input,
      `Promoting to ${input.channel}`,
    );
  }

  /** Pause, roll back or roll back to embedded — never gated. */
  async stop(
    appId: string,
    channel: string,
    action: 'pause' | 'rollback' | 'rollback-to-embedded',
    apiKey: string,
    platform: string | null = null,
  ): Promise<PromotionResult> {
    return await this.postJson<PromotionResult>(
      `/ota/apps/${appId}/channels/${channel}/${action}`,
      apiKey,
      { platform },
      `${action} on ${channel}`,
    );
  }

  /** A promotion request's approval state (`pending` until someone decides). */
  async promotionState(path: string, token: string): Promise<{ requestId: string; state: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      throw await errorOf(response, 'Reading the approval request');
    }
    return (await response.json()) as { requestId: string; state: string };
  }

  /** Exchange a GitHub Actions OIDC token for an upload session (trusted publishing). */
  async exchangeOidc(appId: string, idToken: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/ota/auth/oidc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, token: idToken }),
    });
    if (!response.ok) {
      throw await errorOf(response, 'Exchanging the GitHub OIDC token (is the repository trusted in Mocco?)');
    }
    const { sessionToken } = (await response.json()) as { sessionToken: string };
    return sessionToken;
  }

  /** The status of the release a session uploaded. */
  async sessionReleaseStatus(session: string, releaseId: string): Promise<{ id: string; status: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/ota/uploads/${releaseId}`, {
      headers: { authorization: `Bearer ${session}` },
    });
    if (!response.ok) {
      throw await errorOf(response, 'Reading the release');
    }
    return (await response.json()) as { id: string; status: string };
  }

  async sessionPromote(
    session: string,
    releaseId: string,
    input: { channel: string; rolloutPercent: number },
  ): Promise<PromotionResult> {
    return await this.postJson<PromotionResult>(
      `/ota/uploads/${releaseId}/promotions`,
      session,
      input,
      `Promoting to ${input.channel}`,
    );
  }

  /** Exchange a secret API key with `ota:write` for an upload session token. */
  async createSession(appId: string, apiKey: string): Promise<string> {
    const { sessionToken } = await this.postJson<{ sessionToken: string }>(
      `/ota/apps/${appId}/upload-sessions`,
      apiKey,
      {},
      'Starting an upload session',
    );
    return sessionToken;
  }

  async declare(session: string, request: UploadRequest): Promise<UploadResponse> {
    return await this.postJson<UploadResponse>('/ota/uploads', session, request, 'Declaring the release');
  }

  async put(target: UploadResponse['missing'][number], bytes: Uint8Array): Promise<void> {
    const response = await this.fetchImpl(target.putUrl, {
      method: 'PUT',
      headers: target.headers,
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw await errorOf(response, `Uploading asset ${target.hash}`);
    }
  }

  async finalize(session: string, releaseId: string, request: FinalizeRequest): Promise<FinalizeResult> {
    return await this.postJson<FinalizeResult>(
      `/ota/uploads/${releaseId}/finalize`,
      session,
      request,
      'Finalizing the release',
    );
  }
}
