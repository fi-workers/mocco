// The `@mocco/react-native/ota` entry: hosted OTA updates on the stock expo-updates client.
import { DEFAULT_BASE_URL } from '@mocco/sdk-core';
// eslint-disable-next-line import-x/no-unresolved -- a peer dependency the app installs
import * as Updates from 'expo-updates';
import { useEffect } from 'react';
// eslint-disable-next-line import-x/no-unresolved -- a peer dependency the app installs
import { AppState, Platform } from 'react-native';

import { isMandatoryUpdate, launchEventOf, otaStatusOf, postOtaEvents } from './ota-state';

import type { MoccoUpdateStatus, OtaReporter } from './ota-state';

export interface MoccoOtaProps {
  /** The Mocco OTA app id (in the manifest URL). */
  appId: string;
  /** A stable per-install id (e.g. from expo-application); hashed by Mocco, never stored raw. */
  clientId: string;
  /** Defaults to Mocco's public API. */
  apiBase?: string;
  /** Report launches and emergency launches (default true). */
  reportEvents?: boolean;
}

const state: { reporter: OtaReporter | null } = { reporter: null };

const platformOf = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android');

/**
 * Mount once near the root. Reports this launch to Mocco — `emergency_launch` when the
 * update crashed and expo-updates fell back to the embedded bundle — which drives the
 * console's adoption numbers and the emergency-launch alert. Renders nothing.
 */
export function MoccoOta(props: MoccoOtaProps): null {
  const { appId, clientId, apiBase = DEFAULT_BASE_URL, reportEvents = true } = props;
  useEffect(() => {
    state.reporter = { apiBase, appId, clientId, platform: platformOf() };
    if (reportEvents) {
      const event = launchEventOf(
        { isEmergencyLaunch: Updates.isEmergencyLaunch, updateId: Updates.updateId },
        new Date(),
      );
      // eslint-disable-next-line no-void -- fire and forget: reporting is best effort and never throws
      void postOtaEvents(state.reporter, [event]);
    }
  }, [apiBase, appId, clientId, reportEvents]);
  return null;
}

/** Report an error tied to the running update (best effort; needs `<MoccoOta>` mounted). */
export async function reportOtaError(error: unknown): Promise<void> {
  if (state.reporter === null) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await postOtaEvents(state.reporter, [
    {
      type: 'error',
      updateId: Updates.updateId,
      occurredAt: new Date().toISOString(),
      // eslint-disable-next-line sonarjs/null-dereference -- message is a string, never null
      detail: { message: message.slice(0, 500) },
    },
  ]);
}

export interface MoccoUpdate {
  status: MoccoUpdateStatus;
  /** The pending or available update is a mandatory release. */
  isMandatory: boolean;
  /** Restart into the downloaded update now. */
  applyNow: () => Promise<void>;
}

/**
 * The update state for your UI. An available update downloads in the background; a
 * mandatory one is applied at the next safe point — when the app comes back to the
 * foreground — so the user isn't interrupted mid-task.
 */
// sonarjs/function-return-type is a false positive: the hook always returns a MoccoUpdate.

export function useMoccoUpdate(): MoccoUpdate {
  const updates = Updates.useUpdates();
  const isMandatory = isMandatoryUpdate(updates.downloadedUpdate?.manifest ?? updates.availableUpdate?.manifest);
  const { isUpdateAvailable, isDownloading, isUpdatePending } = updates;

  useEffect(() => {
    if (isUpdateAvailable && !isDownloading && !isUpdatePending) {
      // eslint-disable-next-line no-void -- download in the background; expo-updates reports errors in its state
      void Updates.fetchUpdateAsync();
    }
  }, [isUpdateAvailable, isDownloading, isUpdatePending]);

  useEffect(() => {
    // A mandatory update applies when the app comes back to the foreground.
    const subscription =
      isMandatory && isUpdatePending
        ? AppState.addEventListener('change', next => {
            if (next === 'active') {
              // eslint-disable-next-line no-void -- the app restarts into the update; nothing to await
              void Updates.reloadAsync();
            }
          })
        : null;
    return () => {
      subscription?.remove();
    };
  }, [isMandatory, isUpdatePending]);

  return { status: otaStatusOf(updates), isMandatory, applyNow: async () => await Updates.reloadAsync() };
}

export { isMandatoryUpdate, otaStatusOf } from './ota-state';
export type { MoccoUpdateStatus } from './ota-state';
export type { OtaEvent } from '@mocco/sdk-core';
