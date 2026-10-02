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
