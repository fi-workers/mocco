// `mocco_ota_*` — what a project's hosted OTA channels serve now, which releases CI
// uploaded, how many devices run them, and the version policy of each store app.
// Read-only: promoting, rolling out, pausing, rolling back and changing a policy are
// decisions, and the deciding tools have their own machinery that these do not borrow.
//
// Thin adapters (ADR 0025) over the services the console's `ota` and `ota.hosting`
// routers read through. OTA is project-scoped, so every call first goes through
// `ProjectScope` — membership, the OTA product, the project in that workspace — with the
// caller's own id. A hosted app is then looked up only inside that project, exactly as
// every `ota.hosting` procedure does with `requireApp` before it reads. The filtering and
// paging here only narrow what the service returned; they decide nothing.
import { OtaApprovalSubjects } from '@mocco/common/ota';
import { OtaPlatforms, OtaReleaseStatuses } from '@mocco/common/ota-hosting';
import { AppPlatforms, Products } from '@mocco/common/project';
import { z } from 'zod';

import { AppUnclearError } from '@backend/domain/mcp/errors';
import { OtaAppNotFoundError, OtaChannelNotFoundError } from '@backend/domain/ota/errors';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { OtaChannelService } from '@backend/domain/ota/OtaChannelService';
import type { OtaHostingService } from '@backend/domain/ota/OtaHostingService';
import type { OtaMetricsService } from '@backend/domain/ota/OtaMetricsService';
import type { OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { UploadService } from '@backend/domain/ota/UploadService';
import type { VersionPolicyService } from '@backend/domain/ota/VersionPolicyService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { OtaChannelHeadDto, OtaReleaseStatus } from '@mocco/common/ota-hosting';
import type { McpServer } from '@modelcontextprotocol/server';

export interface OtaToolDeps {
  /** Finds the hosted app (the scoping step of every `ota.hosting` procedure) and its channels. */
  otaHosting: Pick<OtaHostingService, 'listApps' | 'requireApp' | 'listChannels'>;
  otaChannels: Pick<OtaChannelService, 'listHeads'>;
  otaReleases: Pick<UploadService, 'listReleases'>;
  otaMetrics: Pick<OtaMetricsService, 'channelReach' | 'monthlyActiveDevices'>;
  versionPolicies: Pick<VersionPolicyService, 'get' | 'listChanges'>;
  /** The project's apps, to name the choices and find the store apps. */
  projectApps: Pick<ProjectService, 'listApps'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** How many applied policy changes the detailed shape carries per app. */
const RECENT_CHANGES = 5;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the app belongs to. Omit it when the workspace has exactly one.');

const hostedAppArg = z
  .uuid()
  .optional()
  .describe("The hosted OTA app, by its id or its project app's id. Omit it when the project hosts exactly one.");

const responseFormatArg = (concise: string, detailed: string) =>
  z.enum(['concise', 'detailed']).default('concise').describe(`\`concise\` is ${concise}; \`detailed\` ${detailed}.`);

const channelsInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  channel: z.string().min(1).optional().describe('Only this channel, by name (e.g. `production`).'),
  responseFormat: responseFormatArg(
    'what each channel serves now, per platform and runtime version',
    'adds the channel ids, its approval policy and which rollbacks are pre-signed',
  ),
});

const releaseStatuses = Object.values(OtaReleaseStatuses) as [OtaReleaseStatus, ...OtaReleaseStatus[]];

const releasesInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  query: z.string().min(1).optional().describe('Text the release message contains, or a git SHA prefix.'),
  runtimeVersion: z.string().min(1).optional().describe('Only releases for this runtime version.'),
  status: z
    .enum(releaseStatuses)
    .optional()
    .describe('Only releases in this state. `ready` releases are verified and can be promoted.'),
  platform: z
    .enum([OtaPlatforms.ios, OtaPlatforms.android])
    .optional()
    .describe('Only releases with an update for this platform.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  before: z.string().optional().describe("Cursor: the previous answer's `nextBefore`, as it was given."),
  responseFormat: responseFormatArg(
    'id, runtime version, state, message and commit',
    'adds the platforms, download size, whether it is mandatory and who uploaded it',
  ),
});

const adoptionInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  channel: z.string().min(1).optional().describe('Only devices on this channel, by name.'),
  responseFormat: responseFormatArg('devices per channel and release', 'splits them by platform and runtime version'),
});

const versionPoliciesInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: z
    .uuid()
    .optional()
    .describe("Only this iOS or Android app of the project. Omit it for every one of the project's store apps."),
  responseFormat: responseFormatArg(
    'the minimum, recommended and blocked versions',
    'adds the update messages, the store link, the approval policy and the latest applied changes',
  ),
});

export type SearchOtaChannelsArgs = z.infer<typeof channelsInput>;
export type SearchOtaReleasesArgs = z.infer<typeof releasesInput>;
export type GetOtaAdoptionArgs = z.infer<typeof adoptionInput>;
export type SearchVersionPoliciesArgs = z.infer<typeof versionPoliciesInput>;

const resolveOtaProject = async (deps: OtaToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.ota);

/**
 * The hosted app a call reads, inside the resolved project. It may be named by its own id
 * or by its project app's id (the one version policies use); left out when the project
 * hosts exactly one. Another project's app reads exactly like one that does not exist.
 */
async function resolveHostedApp(
  deps: OtaToolDeps,
  userId: string,
  args: { workspaceId?: string; projectId?: string; appId?: string },
): Promise<{ app: OtaAppRow; name: string }> {
  const { workspaceId, projectId } = await resolveOtaProject(deps, userId, args);
  const [hosted, projectApps] = await Promise.all([
    deps.otaHosting.listApps(workspaceId, projectId),
    deps.projectApps.listApps(workspaceId, projectId),
  ]);
  const nameOf = (projectAppId: string) => projectApps.find(each => each.id === projectAppId)?.name ?? projectAppId;
  let chosen: (typeof hosted)[number] | undefined;
  if (args.appId === undefined) {
    if (hosted.length !== 1) {
      throw new AppUnclearError(
        'hosted OTA app',
        hosted.map(each => ({ id: each.id, name: nameOf(each.projectAppId) })),
      );
    }
    [chosen] = hosted;
  } else {
    chosen = hosted.find(each => each.id === args.appId || each.projectAppId === args.appId);
  }
  if (chosen === undefined) {
    throw new OtaAppNotFoundError(args.appId ?? '');
  }
  const app = await deps.otaHosting.requireApp(workspaceId, projectId, chosen.id);
  return { app, name: nameOf(chosen.projectAppId) };
}

const percentOf = (bp: number) => bp / 100;

/** What one channel head serves, said in one line. */
function serving(head: OtaChannelHeadDto): string {
  if (head.isServingEmbedded) {
    return 'rolled back to the embedded bundle';
  }
  const rolledBack = head.isRolledBack ? ' (rolled back to it)' : '';
  const active = head.releaseId === null ? 'serves no release' : `serves release ${head.releaseId}${rolledBack}`;
  if (head.candidateReleaseId !== null) {
    const pause = head.isPaused ? ', paused' : '';
    return `${active}; rolling out ${head.candidateReleaseId} to ${percentOf(head.rolloutBp)}%${pause}`;
  }
  return head.isPaused ? `${active}; paused` : active;
}

export async function searchOtaChannels(deps: OtaToolDeps, args: SearchOtaChannelsArgs, userId: string) {
  const { app, name } = await resolveHostedApp(deps, userId, args);
  const [channels, heads] = await Promise.all([deps.otaHosting.listChannels(app), deps.otaChannels.listHeads(app)]);
  const wanted = args.channel === undefined ? channels : channels.filter(each => each.name === args.channel);
  if (args.channel !== undefined && wanted.length === 0) {
    throw new OtaChannelNotFoundError(args.channel);
  }
  const isDetailed = args.responseFormat === 'detailed';
  return {
    app: { id: app.id, projectAppId: app.projectAppId, name },
    channels: wanted.map(channel => ({
      name: channel.name,
      // A protected channel's promotions and rollout changes wait for approval.
      isProtected: channel.isProtected,
      heads: heads
        .filter(head => head.channelId === channel.id)
        .map(head => ({
          platform: head.platform,
          runtimeVersion: head.runtimeVersion,
          serving: serving(head),
          releaseId: head.releaseId,
          ...(head.candidateReleaseId !== null && {
            candidateReleaseId: head.candidateReleaseId,
            rolloutPercent: percentOf(head.rolloutBp),
          }),
          isPaused: head.isPaused,
          ...(isDetailed && {
            isRolledBack: head.isRolledBack,
            isServingEmbedded: head.isServingEmbedded,
            canRollBack: head.canRollBack,
            canRollBackToEmbedded: head.canRollBackToEmbedded,
            updatedAt: head.updatedAt,
          }),
        })),
      ...(isDetailed && { id: channel.id, policy: channel.policy, createdAt: channel.createdAt }),
    })),
  };
}

/**
 * Where a release sits in newest-first order, as a string that sorts the same way. The id
 * breaks ties between releases created in the same millisecond.
 */
const positionOf = (release: { createdAt: Date; id: string }) => `${release.createdAt.toISOString()}~${release.id}`;

/** Compares positions by code unit, which is the order `before` filters by. */
function newestFirst(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
}

export async function searchOtaReleases(deps: OtaToolDeps, args: SearchOtaReleasesArgs, userId: string) {
  const { app, name } = await resolveHostedApp(deps, userId, args);
  const releases = await deps.otaReleases.listReleases(app);
  const needle = args.query?.toLowerCase();
  const matching = releases
    .filter(
      release =>
        (needle === undefined ||
          (release.message?.toLowerCase().includes(needle) ?? false) ||
          (release.gitSha?.toLowerCase().startsWith(needle) ?? false)) &&
        (args.runtimeVersion === undefined || release.runtimeVersion === args.runtimeVersion) &&
        (args.status === undefined || release.status === args.status) &&
        (args.platform === undefined || release.platforms.includes(args.platform)),
    )
    .map(release => ({ release, position: positionOf(release) }))
    .filter(({ position }) => args.before === undefined || position < args.before)
    .toSorted((a, b) => newestFirst(a.position, b.position));
  const page = matching.slice(0, args.limit);
  return {
    app: { id: app.id, projectAppId: app.projectAppId, name },
    releases: page.map(({ release }) => ({
      id: release.id,
      runtimeVersion: release.runtimeVersion,
      status: release.status,
      message: release.message,
      gitSha: release.gitSha,
      createdAt: release.createdAt,
      ...(args.responseFormat === 'detailed' && {
        platforms: release.platforms,
        downloadBytes: release.downloadBytes,
        isMandatory: release.isMandatory,
        uploadedByPrincipal: release.uploadedByPrincipal,
      }),
    })),
    // Present when there is more: pass it back as `before` for the next page.
    ...(matching.length > page.length && { nextBefore: page.at(-1)?.position }),
  };
}

export async function getOtaAdoption(deps: OtaToolDeps, args: GetOtaAdoptionArgs, userId: string) {
  const { app, name } = await resolveHostedApp(deps, userId, args);
  const [reach, monthlyActiveDevices] = await Promise.all([
    deps.otaMetrics.channelReach(app),
    deps.otaMetrics.monthlyActiveDevices(app.id),
  ]);
  const rows = reach
    .filter(row => args.channel === undefined || row.channel === args.channel)
    .toSorted((a, b) => b.devices - a.devices);
  // The same channel and release on several platforms or runtimes, added up.
  const byChannelAndRelease = rows
    .reduce<{ channel: string; releaseId: string | null; devices: number }[]>((merged, row) => {
      const same = merged.find(each => each.channel === row.channel && each.releaseId === row.releaseId);
      if (same === undefined) {
        return [...merged, { channel: row.channel, releaseId: row.releaseId, devices: row.devices }];
      }
      same.devices += row.devices;
      return merged;
    }, [])
    .toSorted((a, b) => b.devices - a.devices);
  return {
    app: { id: app.id, projectAppId: app.projectAppId, name },
    // Installs that checked in during the last 30 days.
    monthlyActiveDevices,
    // Installs that checked in during the last 24 hours. A null release is the embedded bundle.
    devicesLast24h: rows.reduce((sum, row) => sum + row.devices, 0),
    reach: args.responseFormat === 'detailed' ? rows : byChannelAndRelease,
  };
}

const STORE_PLATFORMS = new Set<string>([AppPlatforms.ios, AppPlatforms.android]);

export async function searchVersionPolicies(deps: OtaToolDeps, args: SearchVersionPoliciesArgs, userId: string) {
  const { workspaceId, projectId } = await resolveOtaProject(deps, userId, args);
  const projectApps = await deps.projectApps.listApps(workspaceId, projectId);
  // A named app goes to the service as named, so a web app or another project's app is
  // refused by the service's own checks, exactly as in the console.
  const apps =
    args.appId === undefined
      ? projectApps.filter(each => STORE_PLATFORMS.has(each.platform))
      : [projectApps.find(each => each.id === args.appId) ?? { id: args.appId, name: args.appId, platform: null }];
  const isDetailed = args.responseFormat === 'detailed';
  const answers = await Promise.all(
    apps.map(async app => {
      const [policy, changes] = await Promise.all([
        deps.versionPolicies.get(workspaceId, projectId, app.id),
        isDetailed ? deps.versionPolicies.listChanges(workspaceId, projectId, app.id) : Promise.resolve([]),
      ]);
      return {
        appId: app.id,
        name: app.name,
        platform: app.platform,
        // No policy: every version is allowed and nothing prompts an update.
        policy:
          policy === null
            ? null
            : {
                minSupportedVersion: policy.minSupportedVersion,
                recommendedVersion: policy.recommendedVersion,
                blockedVersions: policy.blockedVersions,
                // Tightening changes wait for approval when the policy carries one.
                isGated: policy.approvalPolicy !== null,
                revision: policy.revision,
                updatedAt: policy.updatedAt,
                ...(isDetailed && {
                  messages: policy.messages,
                  storeUrl: policy.storeUrl,
                  softPromptIntervalHours: policy.softPromptIntervalHours,
                  approvalPolicy: policy.approvalPolicy,
                }),
              },
        ...(isDetailed && {
          recentChanges: changes.slice(0, RECENT_CHANGES).map(change => ({
            id: change.id,
            direction: change.direction,
            before: change.before,
            after: change.after,
            actorUserId: change.actorUserId,
            approvalRequestId: change.approvalRequestId,
            reason: change.reason,
            createdAt: change.createdAt,
          })),
        }),
      };
    }),
  );
  return {
    projectId,
    apps: answers,
    // A gated change that waits for approval is an approval request, not part of the policy yet.
    pendingChanges: `mocco_approvals_search with subjectType ${OtaApprovalSubjects.versionPolicy}; the subject id is the app id`,
  };
}

export function registerOtaTools(server: McpServer, deps: OtaToolDeps): void {
  server.registerTool(
    'mocco_ota_channels_search',
    {
      title: 'Find OTA channels',
      description:
        "A hosted OTA app's channels and what each serves now, per platform and runtime version: the release, a rollout in progress and its share, and whether it is paused or rolled back. Read-only.",
      inputSchema: channelsInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchOtaChannels(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_ota_releases_search',
    {
      title: 'Find OTA releases',
      description:
        "Releases CI uploaded to a hosted OTA app, newest first, by message or commit, runtime version, state or platform. Looks at the app's 50 most recent releases.",
      inputSchema: releasesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchOtaReleases(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_ota_adoption_get',
    {
      title: 'Read OTA adoption',
      description:
        'How many devices of a hosted OTA app checked in during the last 24 hours, per channel and the release they run, and its monthly active devices.',
      inputSchema: adoptionInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await getOtaAdoption(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_ota_version_policies_search',
    {
      title: 'Find version policies',
      description:
        "The version policy of a project's iOS and Android apps: the minimum supported, recommended and blocked versions, and whether tightening it needs approval. Read-only.",
      inputSchema: versionPoliciesInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await searchVersionPolicies(deps, args, userIdOf(ctx))),
  );
}
