import { evaluateVersionPolicy, pickVersionMessage, VersionStatuses } from '@mocco/common/ota';
import { AppPlatforms } from '@mocco/common/project';

import type { AppVersionPolicyRepo } from '@backend/domain/ota/repos/app-version-policy.repo';
import type { VersionCheckResponse } from '@mocco/common/ota';

export interface VersionCheckServiceDeps {
  policies: AppVersionPolicyRepo;
}

/** The answer for an app with no policy (or an unknown app id). */
const NO_POLICY: VersionCheckResponse = {
  status: VersionStatuses.ok,
  minSupportedVersion: null,
  recommendedVersion: null,
  message: null,
  storeUrl: null,
  promptIntervalHours: 0,
  revision: 0,
};

/** The store listing URL when the policy sets none, from the app's store identifiers. */
function defaultStoreUrl(app: { platform: string; bundleId: string | null; storeAppId: string | null }) {
  if (app.platform === AppPlatforms.ios && app.storeAppId !== null) {
    return `https://apps.apple.com/app/id${encodeURIComponent(app.storeAppId)}`;
  }
  const androidId = app.storeAppId ?? app.bundleId;
  if (app.platform === AppPlatforms.android && androidId !== null) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidId)}`;
  }
  return null;
}

/**
 * The public, read-only side of version policy: what an app on a given installed
 * version should do (`ok | soft | hard`), with the localized prompt and the store link.
 * Keyed by the app id alone — the policy is shown to every user of the app anyway, so
 * it is not secret — and it never reveals anything workspace-scoped.
 */
export class VersionCheckService {
  constructor(private readonly deps: VersionCheckServiceDeps) {}

  async check(appId: string, version: string, locale?: string): Promise<VersionCheckResponse> {
    const found = await this.deps.policies.findForCheck(appId);
    if (found === undefined) {
      return NO_POLICY;
    }
    const { policy, app } = found;
    const status = evaluateVersionPolicy(policy, version);
    return {
      status,
      minSupportedVersion: policy.minSupportedVersion,
      recommendedVersion: policy.recommendedVersion,
      message: status === VersionStatuses.ok ? null : pickVersionMessage(policy.messages, locale),
      storeUrl: policy.storeUrl ?? defaultStoreUrl(app),
      promptIntervalHours: policy.softPromptIntervalHours,
      revision: policy.revision,
    };
  }
}
