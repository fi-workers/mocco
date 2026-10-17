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
  import type { ComponentType, ReactNode } from 'react';

  interface PrimitiveProps {
    style?: unknown;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { disabled?: boolean; selected?: boolean; busy?: boolean };
    testID?: string;
    children?: ReactNode;
  }
  export const View: ComponentType<PrimitiveProps>;
  export const Text: ComponentType<PrimitiveProps & { numberOfLines?: number }>;
  export const ScrollView: ComponentType<
    PrimitiveProps & { contentContainerStyle?: unknown; keyboardShouldPersistTaps?: 'always' | 'handled' | 'never' }
  >;
  export const Pressable: ComponentType<
    PrimitiveProps & { onPress?: () => void; disabled?: boolean; hitSlop?: number }
  >;
  export const TextInput: ComponentType<
    PrimitiveProps & {
      value?: string;
      onChangeText?: (text: string) => void;
      placeholder?: string;
      placeholderTextColor?: string;
      multiline?: boolean;
      maxLength?: number;
      editable?: boolean;
      returnKeyType?: string;
    }
  >;
  export const ActivityIndicator: ComponentType<PrimitiveProps & { color?: string }>;
  export const Modal: ComponentType<{
    visible?: boolean;
    animationType?: 'none' | 'slide' | 'fade';
    presentationStyle?: 'fullScreen' | 'pageSheet' | 'formSheet' | 'overFullScreen';
    onRequestClose?: () => void;
    children?: ReactNode;
  }>;
  export const AppState: {
    currentState: string;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
  export const Platform: { OS: string };
}
