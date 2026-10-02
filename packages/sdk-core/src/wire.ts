// Wire types of the /v1 endpoints the SDKs call (types only: no runtime schema library in
// the bundles). The backend's contract test checks them against the route schemas.

/** What a device reports (`POST /v1/ota/apps/:appId/events`). */
export type OtaEventType = 'launched' | 'emergency_launch' | 'error';

export interface OtaEvent {
  type: OtaEventType;
  updateId: string | null;
  occurredAt: string;
  detail?: Record<string, string | number | boolean>;
}

export interface OtaEventsRequest {
  clientId: string;
  platform: 'ios' | 'android';
  events: OtaEvent[];
}

export type OtaPlatform = 'ios' | 'android';

/** `POST /v1/ota/uploads`: declare a release and its assets. */
export interface OtaUploadRequest {
  runtimeVersion: string;
  platforms: OtaPlatform[];
  assets: { hash: string; size: number; contentType: string; ext: string | null }[];
  gitSha: string | null;
  message: string | null;
  mandatory: boolean;
}

export interface OtaUploadResponse {
  releaseId: string;
  assetBaseUrl: string;
  missing: { hash: string; putUrl: string; headers: Record<string, string> }[];
  rollbackTargets: { channel: string; platform: OtaPlatform; updateId: string; manifest: string }[];
}

interface OtaSignedBody {
  platform: OtaPlatform;
  body: string;
  signature: { sig: string; keyid: string } | null;
}

/** `POST /v1/ota/uploads/:releaseId/finalize`. */
export interface OtaFinalizeRequest {
  updates: OtaSignedBody[];
  republishes: (OtaSignedBody & { targetUpdateId: string })[];
  directives: OtaSignedBody[];
}

/** A channel change: applied now, or pending approval on a protected channel. */
export interface OtaPromotionResult {
  channel: string;
  releaseId: string | null;
  kind: string;
  platforms: OtaPlatform[];
  changed: boolean;
  outcome: 'applied' | 'pending_approval';
  requestId: string | null;
}

/** What the SDK attaches about the device and app to messenger calls. */
export interface MessengerContext {
  appVersion?: string;
  build?: string;
  platform?: 'ios' | 'android' | 'web';
  os?: string;
  device?: string;
  locale?: string;
  timezone?: string;
  screen?: string;
  sdkVersion?: string;
}

/** `POST /v1/messenger/sessions`: the app's user, signed by the app's server. */
export interface MessengerSessionRequest {
  userId: string;
  userHash: string;
  name?: string;
  email?: string;
  traits?: Record<string, string | number | boolean>;
  context?: MessengerContext;
}

export interface MessengerCategory {
  key: string;
  label: string;
}

export interface MessengerSessionResponse {
  sessionToken: string;
  expiresAt: string;
  contactId: string;
  categories: MessengerCategory[];
}

/** A conversation as its user sees it. */
export interface MessengerConversation {
  id: string;
  status: 'open' | 'closed';
  category: string | null;
  preview: string;
  lastMessageSeq: number;
  lastMessageAt: string;
  /** The team replied after the user last read. */
  hasUnread: boolean;
  createdAt: string;
}

/** A message as its user sees it (the team's internal notes never appear). */
export interface MessengerMessage {
  id: string;
  seq: number;
  author: 'contact' | 'operator' | 'system';
  authorName: string | null;
  body: string;
  /** Screenshots, with download links that work for a few minutes. */
  attachments: MessengerAttachment[];
  createdAt: string;
}

export interface MessengerAttachment {
  id: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export type MessengerAttachmentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** `POST /v1/messenger/attachments`. */
export interface MessengerAttachmentRequest {
  contentType: MessengerAttachmentType;
  sizeBytes: number;
  filename?: string;
}

export interface MessengerAttachmentResponse {
  attachmentId: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}

export interface MessengerConversationRequest {
  category?: string;
  body: string;
  clientMessageId: string;
  attachmentIds?: string[];
  context?: MessengerContext;
}

export interface MessengerMessageRequest {
  body: string;
  clientMessageId: string;
  attachmentIds?: string[];
  context?: MessengerContext;
}
