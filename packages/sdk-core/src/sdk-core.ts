// The public entry of @mocco/sdk-core (the package's "exports" target).
export { DEFAULT_BASE_URL, MoccoClient, withoutTrailingSlashes } from './client';
export type { ConditionalResult, MoccoClientOptions, RequestOptions, WhoAmI } from './client';
export { MoccoError, MoccoKeyError, MoccoNetworkError } from './errors';
export { checkKey, keyKindOf } from './keys';
export type { KeyKind } from './keys';
export { backoffMs, isRetryableStatus } from './retry';
export { readServerSentEvents } from './sse';
export type { ServerSentEvent } from './sse';
export type {
  MessengerAttachment,
  MessengerAttachmentRequest,
  MessengerAttachmentResponse,
  MessengerAttachmentType,
  MessengerCategory,
  MessengerContext,
  MessengerConversation,
  MessengerConversationRequest,
  MessengerMessage,
  MessengerMessageRequest,
  MessengerPushTokenRequest,
  MessengerSessionRequest,
  MessengerSessionResponse,
} from './wire';
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
export { DEFAULT_TELEMETRY_INTERVAL_MS, EvaluationCounter, TELEMETRY_PATH } from './telemetry';
export type { EvaluationCount, EvaluationCounterOptions } from './telemetry';
export { DEFAULT_MESSENGER_POLL_MS, MessengerClient, messengerConversationIdOf } from './messenger';
export type { MessengerClientOptions, MessengerIdentity, MessengerState, MessengerStorage } from './messenger';
export { HelpClient } from './help';
export type {
  HelpArticle,
  HelpArticleEntry,
  HelpArticleHit,
  HelpClientOptions,
  HelpCollection,
  HelpReadOptions,
  HelpSearchOptions,
  HelpSearchResult,
  HelpSite,
} from './help';
