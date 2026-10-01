// The slices of the peer dependencies this package uses (the app provides the real
// packages; this keeps their large type trees out of the SDK's build).
declare module 'expo-updates' {
  export interface UpdateInfo {
    updateId?: string;
    manifest?: unknown;
  }
  export interface UseUpdatesReturnType {
    isUpdateAvailable: boolean;
    isUpdatePending: boolean;
    isChecking: boolean;
    isDownloading: boolean;
    availableUpdate?: UpdateInfo;
    downloadedUpdate?: UpdateInfo;
    checkError?: Error;
    downloadError?: Error;
  }
  export const isEmergencyLaunch: boolean;
  export const isEmbeddedLaunch: boolean;
  export const updateId: string | null;
  export const channel: string | null;
  export function useUpdates(): UseUpdatesReturnType;
  export function fetchUpdateAsync(): Promise<{ isNew: boolean }>;
  export function reloadAsync(): Promise<void>;
}

declare module 'react-native' {
  export const AppState: {
    currentState: string;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
  export const Platform: { OS: string };
}
