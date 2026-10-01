// The public entry of @mocco/sdk-core (the package's "exports" target).
export { DEFAULT_BASE_URL, MoccoClient, withoutTrailingSlashes } from './client';
export type { MoccoClientOptions, RequestOptions, WhoAmI } from './client';
export { MoccoError, MoccoKeyError, MoccoNetworkError } from './errors';
export { checkKey, keyKindOf } from './keys';
export type { KeyKind } from './keys';
export { backoffMs, isRetryableStatus } from './retry';
export type {
  OtaEvent,
  OtaEventsRequest,
  OtaEventType,
  OtaFinalizeRequest,
  OtaPlatform,
  OtaPromotionResult,
  OtaUploadRequest,
  OtaUploadResponse,
} from './wire';
