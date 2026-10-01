// Pure pieces of the OTA hooks (no React Native imports), so they can be tested anywhere.
import { withoutTrailingSlashes } from '@mocco/sdk-core';

import type { OtaEvent, OtaEventsRequest } from '@mocco/sdk-core';
import type { UseUpdatesReturnType } from 'expo-updates';

export type MoccoUpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

/** One status from expo-updates' hook state. */
export function otaStatusOf(state: UseUpdatesReturnType): MoccoUpdateStatus {
  if (state.checkError !== undefined || state.downloadError !== undefined) {
    return 'error';
  }
  if (state.isUpdatePending) {
    return 'ready';
  }
  if (state.isDownloading) {
    return 'downloading';
  }
  return state.isChecking ? 'checking' : 'idle';
}

/** Whether a manifest is a mandatory Mocco release (`mocco-ota publish --mandatory`). */
export function isMandatoryUpdate(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) {
    return false;
  }
  const { extra } = manifest as { extra?: { mocco?: { mandatory?: unknown } } };
  return extra?.mocco?.mandatory === true;
}

/** The launch event to report: an emergency launch means the update crashed and the
 * embedded bundle took over. */
export function launchEventOf(launch: { isEmergencyLaunch: boolean; updateId: string | null }, now: Date): OtaEvent {
  return {
    type: launch.isEmergencyLaunch ? 'emergency_launch' : 'launched',
    updateId: launch.updateId,
    occurredAt: now.toISOString(),
  };
}

export interface OtaReporter {
  apiBase: string;
  appId: string;
  clientId: string;
  platform: 'ios' | 'android';
  fetch?: typeof fetch;
}

/** Send events to Mocco (`POST /v1/ota/apps/:appId/events`). Best effort: never throws. */
export async function postOtaEvents(reporter: OtaReporter, events: readonly OtaEvent[]): Promise<boolean> {
  try {
    const response = await (reporter.fetch ?? globalThis.fetch)(
      `${withoutTrailingSlashes(reporter.apiBase)}/ota/apps/${reporter.appId}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: reporter.clientId,
          platform: reporter.platform,
          events: events.slice(0, 50),
        } satisfies OtaEventsRequest),
      },
    );
    return response.status === 202;
  } catch {
    return false;
  }
}
