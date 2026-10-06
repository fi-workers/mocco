import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { AuthService } from '@backend/domain/auth/AuthService';
import type { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import type { GrantService } from '@backend/domain/credential/GrantService';
import type { RunService } from '@backend/domain/execution/RunService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { CommentService } from '@backend/domain/feedback/CommentService';
import type { MergeService } from '@backend/domain/feedback/MergeService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { FlagGovernanceService } from '@backend/domain/flags/FlagGovernanceService';
import type { FlagService } from '@backend/domain/flags/FlagService';
import type { FlagTelemetryService } from '@backend/domain/flags/FlagTelemetryService';
import type { KillSwitchService } from '@backend/domain/flags/KillSwitchService';
import type { StaleFlagDetector } from '@backend/domain/flags/StaleFlagDetector';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { GateService } from '@backend/domain/governance/GateService';
import type { RoleService } from '@backend/domain/governance/RoleService';
import type { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import type { HelpFeedbackService } from '@backend/domain/helpcenter/HelpFeedbackService';
import type { HelpImageService } from '@backend/domain/helpcenter/HelpImageService';
import type { HelpImportService } from '@backend/domain/helpcenter/HelpImportService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import type { InboundDomain } from '@backend/domain/inbound/instance';
import type { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import type { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import type { ConnectionService } from '@backend/domain/integration/ConnectionService';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { InboxService } from '@backend/domain/messenger/InboxService';
import type { MessengerSettingsService } from '@backend/domain/messenger/MessengerSettingsService';
import type { ActivityService } from '@backend/domain/notification/ActivityService';
import type { ChannelService } from '@backend/domain/notification/ChannelService';
import type { ExternalCredentialService } from '@backend/domain/ota/ExternalCredentialService';
import type { OtaChannelService } from '@backend/domain/ota/OtaChannelService';
import type { OtaHostingService } from '@backend/domain/ota/OtaHostingService';
import type { OtaMetricsService } from '@backend/domain/ota/OtaMetricsService';
import type { SigningService } from '@backend/domain/ota/SigningService';
import type { TrustPolicyService } from '@backend/domain/ota/TrustPolicyService';
import type { UploadService } from '@backend/domain/ota/UploadService';
import type { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import type { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { CorrelationService } from '@backend/domain/status/CorrelationService';
import type { IncidentService } from '@backend/domain/status/IncidentService';
import type { LocationService } from '@backend/domain/status/LocationService';
import type { MaintenanceService } from '@backend/domain/status/MaintenanceService';
import type { MonitorService } from '@backend/domain/status/MonitorService';
import type { StatusPageService } from '@backend/domain/status/StatusPageService';
import type { Session } from '@mocco/common/auth';

/** Per-request tRPC context — session read via the neutral auth surface. Optional
 * services are required keys typed `X | undefined`, so a context builder that forgets
 * one fails to compile instead of silently disabling a router. */
export interface Context {
  /** Injected services (production instances or per-test pglite ones). */
  auth: AuthService;
  workspace: WorkspaceService;
  /** Present only when the GitHub App is configured; the integration router asserts it. */
  connection: ConnectionService | undefined;
  /** Present only when the GitHub App is configured (same condition as `connection`). */
  commitSync: CommitSyncService | undefined;
  /** Present only when the GitHub App is configured (same condition as `connection`). */
  commitConfig: CommitConfigService | undefined;
  /** Always present — the execution domain has no external dependency to gate on. */
  runs: RunService;
  /** Always present — the governance domain has no external dependency to gate on. */
  roles: RoleService;
  /** Always present — resolves a run's gate; the run router's resumeGate delegates here. */
  gates: GateService;
  /** Always present — approvals outside runs (#114). */
  approvals: ApprovalService;
  /** Always present — the credential allowlist has no external dependency to gate on. */
  grants: GrantService;
  /** Always present — the audit hash chain is self-contained (no external dependency). */
  audit: AuditService;
  /** Always present — projects have no external dependency to gate on (ADR 0013). */
  projects: ProjectService;
  /** Always present — which product lines the workspace has enabled. */
  products: ProductEnablementService;
  /** Always present — OTA version policy and native force update. */
  versionPolicies: VersionPolicyService;
  /** Always present — sealed publishing tokens of the team's existing OTA tools. */
  externalCredentials: ExternalCredentialService;
  /** Always present — Mocco-hosted OTA apps and channels (ADR 0021). */
  otaHosting: OtaHostingService;
  /** Always present — OTA code-signing certificates (ADR 0022). */
  otaSigning: SigningService;
  /** Always present — OTA releases uploaded from CI. */
  otaUploads: UploadService;
  /** Always present — what OTA channels serve, and promotions. */
  otaChannels: OtaChannelService;
  /** Always present — trusted publishing from GitHub Actions. */
  otaTrustPolicies: TrustPolicyService;
  /** Always present — OTA adoption metrics. */
  otaMetrics: OtaMetricsService;
  /** Feature flags of a project (#137). */
  flags: FlagService;
  /** Changesets to protected environments: votes, withdraw, rebase, change gates (#141). */
  flagGovernance: FlagGovernanceService;
  /** The flags kill switch (#142). */
  flagKillSwitch: KillSwitchService;
  /** Evaluation counts from SDK telemetry (#144). */
  flagTelemetry: FlagTelemetryService;
  /** Stale-flag findings (#144). */
  staleFlags: StaleFlagDetector;
  /** The messenger's settings and the team inbox (#95). */
  messengerSettings: MessengerSettingsService;
  inbox: InboxService;
  /** The help center: its site and writing articles (#96). */
  helpSites: HelpSiteService;
  helpAuthoring: HelpAuthoringService;
  helpImport: HelpImportService;
  helpImages: HelpImageService;
  helpTranslations: HelpTranslationService;
  helpFeedback: HelpFeedbackService;
  /** Feedback boards, their categories and posts (#172), votes, comments, subscriptions and merges (#173). */
  feedbackBoards: BoardService;
  feedbackPosts: PostService;
  feedbackVotes: VoteService;
  feedbackComments: CommentService;
  feedbackSubscriptions: SubscriptionService;
  feedbackMerges: MergeService;
  /** The status page: pages and components, incidents, maintenance (#148). */
  statusPages: StatusPageService;
  statusIncidents: IncidentService;
  statusMaintenances: MaintenanceService;
  /** Monitors and probe locations (#150). */
  statusMonitors: MonitorService;
  statusLocations: LocationService;
  /** Deploy correlation: the runs linked to incidents, both ways (#154). */
  statusCorrelation: CorrelationService;
  /** Always present — API keys for the public /v1 surface (ADR 0017). */
  apiKeys: ApiKeyService;
  /** Always present — what a workspace allows agents on the MCP surface (ADR 0025). */
  mcpSettings: McpSettingsService;
  /** Present only when SECRETS_ENCRYPTION_KEYS is set (sources store sealed secrets);
   * the inbound router asserts it. */
  inbound: InboundDomain | undefined;
  /** Notification channels, rules and deliveries; the notification router asserts it. */
  notifications: ChannelService | undefined;
  /** The notification activity trace; the notification router's `activity` asserts it. */
  notificationActivity: ActivityService | undefined;
  session: Session | null;
  /** Original request headers — forwarded to neutral auth calls (cookie-based). */
  headers: Headers;
}

/** Mask internal errors before they reach the client: an uncaught throw surfaces
 * as INTERNAL_SERVER_ERROR whose message is the raw cause (SQL, vendor detail) —
 * replace it with a generic message. Explicit domain errors (BAD_REQUEST,
 * UNAUTHORIZED, …) keep their message. Pure, so it is unit-tested directly. */
export function maskInternalError<S extends { message: string }>(shape: S, code: string): S {
  if (code === 'INTERNAL_SERVER_ERROR') {
    return { ...shape, message: 'Internal server error' };
  }
  return shape;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error }) => maskInternalError(shape, error.code),
});

export const { router } = t;
export const publicProcedure = t.procedure;

/** Requires a signed-in user; narrows ctx.session to non-null. */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return await next({ ctx: { ...ctx, session: ctx.session } });
});
