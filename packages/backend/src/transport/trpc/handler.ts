import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { getApiKeys } from '@backend/domain/apikey/instance';
import { getAudit } from '@backend/domain/audit/instance';
import { getServices, type Services } from '@backend/domain/auth/instance';
import { getCredential } from '@backend/domain/credential/instance';
import { getExecution } from '@backend/domain/execution/instance';
import { getFlagsDomain } from '@backend/domain/flags/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { getInbound } from '@backend/domain/inbound/instance';
import { getIntegration } from '@backend/domain/integration/instance';
import { getMcpSettings } from '@backend/domain/mcp/instance';
import { getMessengerDomain } from '@backend/domain/messenger/instance';
import { getNotification } from '@backend/domain/notification/instance';
import { getOtaDomain } from '@backend/domain/ota/instance';
import { getProjectDomain } from '@backend/domain/project/instance';
import { getStatusDomain } from '@backend/domain/status/instance';
import { appRouter } from '@backend/transport/trpc/root';

import type { ApiKeyService } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { GrantService } from '@backend/domain/credential/GrantService';
import type { RunService } from '@backend/domain/execution/RunService';
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
import type { Context } from '@backend/transport/trpc/trpc';

/** Injected per-handler deps. `connection`/`commitSync`/`commitConfig` are present only
 * when the GitHub App is configured; `runs` is always present (no external dependency). */
export interface TrpcDeps extends Services {
  connection: ConnectionService | undefined;
  commitSync: CommitSyncService | undefined;
  commitConfig: CommitConfigService | undefined;
  runs: RunService;
  roles: RoleService;
  gates: GateService;
  approvals: ApprovalService;
  grants: GrantService;
  audit: AuditService;
  projects: ProjectService;
  products: ProductEnablementService;
  versionPolicies: VersionPolicyService;
  externalCredentials: ExternalCredentialService;
  apiKeys: ApiKeyService;
  mcpSettings: McpSettingsService;
  otaHosting: OtaHostingService;
  otaSigning: SigningService;
  otaUploads: UploadService;
  otaChannels: OtaChannelService;
  otaTrustPolicies: TrustPolicyService;
  otaMetrics: OtaMetricsService;
  flags: FlagService;
  flagGovernance: FlagGovernanceService;
  flagKillSwitch: KillSwitchService;
  flagTelemetry: FlagTelemetryService;
  staleFlags: StaleFlagDetector;
  messengerSettings: MessengerSettingsService;
  inbox: InboxService;
  helpSites: HelpSiteService;
  helpAuthoring: HelpAuthoringService;
  helpImport: HelpImportService;
  helpImages: HelpImageService;
  helpTranslations: HelpTranslationService;
  helpFeedback: HelpFeedbackService;
  statusPages: StatusPageService;
  statusIncidents: IncidentService;
  statusMaintenances: MaintenanceService;
  statusMonitors: MonitorService;
  statusLocations: LocationService;
  statusCorrelation: CorrelationService;
  /** Present only when SECRETS_ENCRYPTION_KEYS is set. */
  inbound: InboundDomain | undefined;
  notifications: ChannelService | undefined;
  notificationActivity: ActivityService | undefined;
}

/** DI factory — production binds it below; tests bind it to pglite. */
export function createTrpcHandler(deps: TrpcDeps) {
  return async (request: Request): Promise<Response> =>
    await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: request,
      router: appRouter,
      // Invariant: procedures read the session from `request.headers` but this
      // handler does NOT forward any `Set-Cookie` an auth call might emit back
      // onto the response. It holds only because the tRPC-path auth calls today
      // (list/create/setActive/getActive) mutate the DB session row, not cookies.
      // If that changes — session cookieCache, sign-in/out moved onto tRPC, or
      // vendor session rotation — capture the auth Response headers and merge
      // Set-Cookie here (via responseMeta), or those cookie updates are lost.
      createContext: async (): Promise<Context> => ({
        auth: deps.auth,
        workspace: deps.workspace,
        connection: deps.connection,
        commitSync: deps.commitSync,
        commitConfig: deps.commitConfig,
        runs: deps.runs,
        roles: deps.roles,
        gates: deps.gates,
        approvals: deps.approvals,
        grants: deps.grants,
        audit: deps.audit,
        projects: deps.projects,
        products: deps.products,
        versionPolicies: deps.versionPolicies,
        externalCredentials: deps.externalCredentials,
        apiKeys: deps.apiKeys,
        mcpSettings: deps.mcpSettings,
        otaHosting: deps.otaHosting,
        otaSigning: deps.otaSigning,
        otaUploads: deps.otaUploads,
        otaChannels: deps.otaChannels,
        otaTrustPolicies: deps.otaTrustPolicies,
        otaMetrics: deps.otaMetrics,
        flags: deps.flags,
        flagGovernance: deps.flagGovernance,
        flagKillSwitch: deps.flagKillSwitch,
        flagTelemetry: deps.flagTelemetry,
        staleFlags: deps.staleFlags,
        messengerSettings: deps.messengerSettings,
        inbox: deps.inbox,
        helpSites: deps.helpSites,
        helpAuthoring: deps.helpAuthoring,
        helpImport: deps.helpImport,
        helpImages: deps.helpImages,
        helpTranslations: deps.helpTranslations,
        helpFeedback: deps.helpFeedback,
        statusPages: deps.statusPages,
        statusIncidents: deps.statusIncidents,
        statusMaintenances: deps.statusMaintenances,
        statusMonitors: deps.statusMonitors,
        statusLocations: deps.statusLocations,
        statusCorrelation: deps.statusCorrelation,
        inbound: deps.inbound,
        notifications: deps.notifications,
        notificationActivity: deps.notificationActivity,
        session: await deps.auth.getSession(request.headers),
        headers: request.headers,
      }),
    });
}

/** The production services every tRPC context carries — the ONE place they are
 * composed. Both `trpcHandler` below and the Pages-Router API route
 * (`pages/api/trpc/[trpc].ts`) build their context from this, so a router's
 * service can't be wired in one entry point and forgotten in the other. */
export function productionServices(): TrpcDeps {
  const integration = getIntegration();
  return {
    ...getServices(),
    connection: integration?.connection,
    commitSync: integration?.commitSync,
    commitConfig: integration?.commitConfig,
    runs: getExecution().runs,
    roles: getGovernance().roles,
    gates: getGovernance().gates,
    approvals: getGovernance().approvals,
    grants: getCredential().grants,
    audit: getAudit().audit,
    projects: getProjectDomain().projects,
    products: getProjectDomain().products,
    versionPolicies: getOtaDomain().versionPolicies,
    externalCredentials: getOtaDomain().externalCredentials,
    apiKeys: getApiKeys(),
    mcpSettings: getMcpSettings(),
    otaHosting: getOtaDomain().otaHosting,
    otaSigning: getOtaDomain().otaSigning,
    otaUploads: getOtaDomain().otaUploads,
    otaChannels: getOtaDomain().otaChannels,
    otaTrustPolicies: getOtaDomain().otaTrustPolicies,
    otaMetrics: getOtaDomain().otaMetrics,
    flags: getFlagsDomain().flags,
    flagGovernance: getFlagsDomain().flagGovernance,
    flagKillSwitch: getFlagsDomain().flagKillSwitch,
    flagTelemetry: getFlagsDomain().flagTelemetry,
    staleFlags: getFlagsDomain().staleFlags,
    messengerSettings: getMessengerDomain().messengerSettings,
    inbox: getMessengerDomain().inbox,
    helpSites: getHelpDomain().helpSites,
    helpAuthoring: getHelpDomain().helpAuthoring,
    helpImport: getHelpDomain().helpImport,
    helpImages: getHelpDomain().helpImages,
    helpTranslations: getHelpDomain().helpTranslations,
    helpFeedback: getHelpDomain().helpFeedback,
    ...getStatusDomain(),
    inbound: getInbound(),
    notifications: getNotification().channels,
    notificationActivity: getNotification().activity,
  };
}

/** Production tRPC fetch handler (prod is mounted via the Pages-Router `pages/api/trpc/[trpc].ts`). */
export async function trpcHandler(request: Request): Promise<Response> {
  return await createTrpcHandler(productionServices())(request);
}
