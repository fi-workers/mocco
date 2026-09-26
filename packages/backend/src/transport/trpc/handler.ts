import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { getAudit } from '@backend/domain/audit/instance';
import { getServices, type Services } from '@backend/domain/auth/instance';
import { getCredential } from '@backend/domain/credential/instance';
import { getExecution } from '@backend/domain/execution/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { getInbound } from '@backend/domain/inbound/instance';
import { getIntegration } from '@backend/domain/integration/instance';
import { getNotification } from '@backend/domain/notification/instance';
import { getOtaDomain } from '@backend/domain/ota/instance';
import { getProjectDomain } from '@backend/domain/project/instance';
import { appRouter } from '@backend/transport/trpc/root';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { GrantService } from '@backend/domain/credential/GrantService';
import type { RunService } from '@backend/domain/execution/RunService';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { GateService } from '@backend/domain/governance/GateService';
import type { RoleService } from '@backend/domain/governance/RoleService';
import type { InboundDomain } from '@backend/domain/inbound/instance';
import type { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import type { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import type { ConnectionService } from '@backend/domain/integration/ConnectionService';
import type { ChannelService } from '@backend/domain/notification/ChannelService';
import type { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import type { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { Context } from '@backend/transport/trpc/trpc';

/** Injected per-handler deps. `connection`/`commitSync`/`commitConfig` are present only
 * when the GitHub App is configured; `runs` is always present (no external dependency). */
export interface TrpcDeps extends Services {
  connection?: ConnectionService;
  commitSync?: CommitSyncService;
  commitConfig?: CommitConfigService;
  runs: RunService;
  roles: RoleService;
  gates: GateService;
  approvals: ApprovalService;
  grants: GrantService;
  audit: AuditService;
  projects: ProjectService;
  products: ProductEnablementService;
  versionPolicies: VersionPolicyService;
  /** Present only when SECRETS_ENCRYPTION_KEYS is set. */
  inbound?: InboundDomain;
  notifications?: ChannelService;
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
        inbound: deps.inbound,
        notifications: deps.notifications,
        session: await deps.auth.getSession(request.headers),
        headers: request.headers,
      }),
    });
}

/** Production tRPC fetch handler (prod is mounted via the Pages-Router `pages/api/trpc/[trpc].ts`). */
export async function trpcHandler(request: Request): Promise<Response> {
  const integration = getIntegration();
  return await createTrpcHandler({
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
    inbound: getInbound(),
    notifications: getNotification().channels,
  })(request);
}
