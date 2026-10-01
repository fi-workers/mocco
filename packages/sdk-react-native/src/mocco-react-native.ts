// The public entry of @mocco/react-native. Product features are subpath exports:
// `@mocco/react-native/ota` (hosted OTA updates); the Expo config plugin is the package
// itself in `app.json` "plugins".
import { MoccoClient } from '@mocco/sdk-core';

export interface MoccoNativeOptions {
  /** A publishable key (`mk_pub_…`): safe to ship in the app. */
  publishableKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createMoccoNative(options: MoccoNativeOptions): MoccoClient {
  return new MoccoClient({
    key: options.publishableKey,
    isBrowser: false,
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
}

export { MoccoError, MoccoKeyError, MoccoNetworkError } from '@mocco/sdk-core';
