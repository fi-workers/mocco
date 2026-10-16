// `mocco_ota_setup_get` and the tools that connect a React Native app to Mocco's OTA
// hosting: host the app, add an open channel, register the app's signing certificate and
// trust a GitHub repository to publish from CI. These are the steps the console's
// "Hosted by Mocco" tab walks through, so an agent working in the app's repository can do
// them where it already is, and read back what is missing.
//
// Nothing here ships an update. Promoting, rolling out, pausing and rolling back are
// decisions with their own approval machinery, and protecting a channel names who must
// approve — a governance choice that stays in the console. A channel made here is open;
// protect it in the console before it carries production traffic that needs approval.
//
// Every change is behind the same locks as the other changing tools (`openDecision`,
// `confirmThenApply` in `deciding.ts`): its own `ota:write` scope, stepped up for per
// tool, the workspace's opt-in, and a confirmation round trip that shows exactly what would
// change. Then the console's own rules: any member with the OTA product may host an app
// and add a channel (`otaProcedure`), and only an owner or admin may add a certificate or
// a trust policy (`adminOtaProcedure`), because those decide whose code devices run.
//
// Thin adapters (ADR 0025) over `OtaHostingService`, `SigningService` and
// `TrustPolicyService`, the services the console's `ota.hosting` router writes through.
// They record each change in the audit log as the person who made it.
import { McpScopes } from '@mocco/common/mcp';
import {
  CHANNEL_NAME_PATTERN,
  DEFAULT_SIGNING_KEY_ID,
  otaTrustPolicyInputSchema,
  SIGNING_ALGORITHM,
} from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { AppUnclearError, ToolUnavailableError } from '@backend/domain/mcp/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { hostedAppArg, projectArg, resolveHostedApp, resolveOtaProject } from '@backend/transport/mcp/tools/ota';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { OtaHostingService } from '@backend/domain/ota/OtaHostingService';
import type { SigningService } from '@backend/domain/ota/SigningService';
import type { TrustPolicyService } from '@backend/domain/ota/TrustPolicyService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { DecidingToolDeps } from '@backend/transport/mcp/tools/deciding';
import type { OtaAppDto, OtaChannelDto, SigningCertificateDto } from '@mocco/common/ota-hosting';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface OtaSetupToolDeps extends DecidingToolDeps {
  /** Absent on a server that does not compose OTA hosting; the tools then say so. */
  otaSetup?: {
    hosting: Pick<OtaHostingService, 'listApps' | 'requireApp' | 'createApp' | 'listChannels' | 'createChannel'>;
    signing: Pick<SigningService, 'list' | 'add'>;
    trustPolicies: Pick<TrustPolicyService, 'list' | 'create'>;
  };
  projectApps: Pick<ProjectService, 'listApps'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

type OtaSetup = NonNullable<OtaSetupToolDeps['otaSetup']>;

export const OtaSetupTools = {
  get: 'mocco_ota_setup_get',
  host: 'mocco_ota_apps_host',
  createChannel: 'mocco_ota_channels_create',
  addCertificate: 'mocco_ota_certificates_add',
  trustRepository: 'mocco_ota_trust_policies_create',
} as const;

const WORDS = {
  verb: 'set up OTA hosting',
  doing: 'Setting up OTA hosting',
  scope: { name: McpScopes.otaWrite, allows: 'set up OTA hosting as you' },
} as const;

/** The channel name rule of `otaChannelCreateInputSchema`. */
const channelNameArg = z.string().regex(CHANNEL_NAME_PATTERN);

const setupInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const hostInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  projectAppId: z
    .uuid()
    .optional()
    .describe(
      'The React Native app of the project to host, as `mocco_ota_setup_get` lists it. Omit it when the project has exactly one that is not hosted yet.',
    ),
});

const channelInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  name: channelNameArg.describe(
    'The channel name builds ask for in their `expo-channel-name` header, e.g. `staging` or `production`.',
  ),
});

const certificateInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  certificatePem: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'The PEM of the X.509 certificate the app embeds as `codeSigningCertificate` (usually `certs/certificate.pem`). Never the private key.',
    ),
  keyid: z
    .string()
    .regex(/^[\w.-]{1,64}$/u)
    .default(DEFAULT_SIGNING_KEY_ID)
    .describe("The `codeSigningMetadata.keyid` of the app's config; expo-updates' default is `root`."),
});

const trustInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  appId: hostedAppArg,
  ...otaTrustPolicyInputSchema.shape,
  repositoryId: otaTrustPolicyInputSchema.shape.repositoryId.describe(
    "The GitHub repository's numeric id (`gh api repos/<owner>/<repo> --jq .id`). It survives a rename, which the name does not.",
  ),
  repository: otaTrustPolicyInputSchema.shape.repository.describe('`owner/name`, to recognise it.'),
  refPattern: otaTrustPolicyInputSchema.shape.refPattern.describe(
    'The git ref a publishing job must run on: `refs/heads/main`, or a pattern such as `refs/tags/v*`.',
  ),
  workflowRef: otaTrustPolicyInputSchema.shape.workflowRef.describe(
    'Only this workflow, as `owner/repo/.github/workflows/ota.yml@refs/heads/main`. Null for any workflow of the repository.',
  ),
  environment: otaTrustPolicyInputSchema.shape.environment.describe(
    'Only jobs in this GitHub environment. Null for any.',
  ),
  allowedChannels: otaTrustPolicyInputSchema.shape.allowedChannels.describe(
    'Open channels a job may promote to. A protected channel cannot be listed: its promotions wait for approval.',
  ),
});

export type GetOtaSetupArgs = z.infer<typeof setupInput>;
export type HostOtaAppArgs = z.infer<typeof hostInput>;
export type CreateOtaChannelArgs = z.infer<typeof channelInput>;
export type AddOtaCertificateArgs = z.infer<typeof certificateInput>;
export type TrustOtaRepositoryArgs = z.infer<typeof trustInput>;

function requireSetup(deps: OtaSetupToolDeps): OtaSetup {
  if (deps.otaSetup === undefined) {
    throw new ToolUnavailableError('OTA hosting is not available on this Mocco server');
  }
  return deps.otaSetup;
}

/** The services' refusals, as the model reads them; anything else is a real failure. */
function setupRefusal(error: unknown): CallToolResult {
  if (
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenError
  ) {
    return refused(error.message);
  }
  throw error;
}

/** The `expo.updates` block that points the app at this hosted app, as the console shows it. */
const updatesBlockOf = (app: OtaAppDto, keyid: string) => ({
  url: app.manifestUrl,
  codeSigningCertificate: './certs/certificate.pem',
  codeSigningMetadata: { keyid, alg: SIGNING_ALGORITHM },
});

const certificateSummary = (certificate: SigningCertificateDto) => ({
  id: certificate.id,
  keyid: certificate.keyid,
  // SHA-256 of the public key: compare it with `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | sha256sum`.
  spkiSha256: certificate.spkiSha256,
  subject: certificate.subject,
  notAfter: certificate.notAfter,
  status: certificate.status,
});

const channelSummary = (channel: OtaChannelDto) => ({
  id: channel.id,
  name: channel.name,
  isProtected: channel.isProtected,
});

/** What still stands between this hosted app and its first update, in the order to do it. */
function missingSteps(state: {
  channels: readonly OtaChannelDto[];
  certificates: readonly SigningCertificateDto[];
  trustPolicies: readonly unknown[];
}): string[] {
  return [
    ...(state.channels.length === 0 ? [`Add a channel builds read from (${OtaSetupTools.createChannel}).`] : []),
    ...(state.certificates.some(each => each.status === 'active')
      ? []
      : [
          `Register the certificate the app embeds (${OtaSetupTools.addCertificate}); until then every upload is refused.`,
        ]),
    ...(state.trustPolicies.length === 0
      ? [
          `Trust the repository that publishes (${OtaSetupTools.trustRepository}), or give CI a secret key with \`ota:write\`.`,
        ]
      : []),
  ];
}

/**
 * The project's React Native apps and, for each hosted one, everything its setup has: the
 * manifest URL and `expo.updates` block, the channels, the certificates and the trusted
 * repositories — and what is still missing. Read-only.
 */
export async function getOtaSetup(deps: OtaSetupToolDeps, args: GetOtaSetupArgs, userId: string) {
  const setup = requireSetup(deps);
  const { workspaceId, projectId } = await resolveOtaProject(deps, userId, args);
  const [projectApps, hosted] = await Promise.all([
    deps.projectApps.listApps(workspaceId, projectId),
    setup.hosting.listApps(workspaceId, projectId),
  ]);
  const reactNative = projectApps.filter(each => each.platform === AppPlatforms.reactNative);
  const apps = await Promise.all(
    reactNative.map(async projectApp => {
      const dto = hosted.find(each => each.projectAppId === projectApp.id);
      if (dto === undefined) {
        return {
          projectAppId: projectApp.id,
          name: projectApp.name,
          isHosted: false,
          next: [`Host it (${OtaSetupTools.host}) to get its manifest URL.`],
        };
      }
      const row = await setup.hosting.requireApp(workspaceId, projectId, dto.id);
      const [channels, certificates, trustPolicies] = await Promise.all([
        setup.hosting.listChannels(row),
        setup.signing.list(row),
        setup.trustPolicies.list(row),
      ]);
      const keyid = certificates.find(each => each.status === 'active')?.keyid ?? DEFAULT_SIGNING_KEY_ID;
      return {
        projectAppId: projectApp.id,
        name: projectApp.name,
        isHosted: true,
        appId: dto.id,
        manifestUrl: dto.manifestUrl,
        // Merge into `expo.updates` of app.json, or run `npx mocco ota init --manifest-url <manifestUrl> --keep-key`.
        updates: updatesBlockOf(dto, keyid),
        channels: channels.map(each => channelSummary(each)),
        certificates: certificates.map(each => certificateSummary(each)),
        trustPolicies: trustPolicies.map(policy => ({
          id: policy.id,
          repository: policy.repository,
          repositoryId: policy.repositoryId,
          refPattern: policy.refPattern,
          workflowRef: policy.workflowRef,
          environment: policy.environment,
          allowedChannels: policy.allowedChannels,
        })),
        next: missingSteps({ channels, certificates, trustPolicies }),
      };
    }),
  );
  return {
    projectId,
    apps,
    ...(reactNative.length === 0 && {
      next: ["Add the app on the project's Overview page with the platform React Native; only those can be hosted."],
    }),
  };
}

/** The checks every setup change makes before it asks: scope, opt-in and a signing key, then the service. */
async function openSetup(deps: OtaSetupToolDeps, ctx: ServerContext, workspaceArgument: string | undefined) {
  const opened = await openDecision(deps, ctx, workspaceArgument, WORDS);
  if ('content' in opened) {
    return opened;
  }
  return { ...opened, setup: requireSetup(deps) };
}

/** The hosted app a change is about, with the setup's services in place of the read tools'. */
const hostedApp = async (
  deps: OtaSetupToolDeps,
  setup: OtaSetup,
  userId: string,
  args: { workspaceId?: string; projectId?: string; appId?: string },
) =>
  await resolveHostedApp(
    { otaHosting: setup.hosting, projectApps: deps.projectApps, projects: deps.projects },
    userId,
    args,
  );

export async function hostOtaApp(
  deps: OtaSetupToolDeps,
  args: HostOtaAppArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openSetup(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, setup } = opened;
    const scope = await resolveOtaProject(deps, userId, { workspaceId, projectId: args.projectId });
    const [projectApps, hosted] = await Promise.all([
      deps.projectApps.listApps(scope.workspaceId, scope.projectId),
      setup.hosting.listApps(scope.workspaceId, scope.projectId),
    ]);
    // Named: handed to the service as named, so a web app or another project's app is
    // refused by its own checks. Left out: the one React Native app not hosted yet.
    let projectApp = projectApps.find(each => each.id === args.projectAppId);
    if (args.projectAppId === undefined) {
      const candidates = projectApps.filter(
        each => each.platform === AppPlatforms.reactNative && hosted.every(app => app.projectAppId !== each.id),
      );
      if (candidates.length !== 1) {
        throw new AppUnclearError(
          'React Native app that is not hosted yet',
          candidates.map(each => ({ id: each.id, name: each.name })),
        );
      }
      [projectApp] = candidates;
    }
    const projectAppId = projectApp?.id ?? args.projectAppId ?? '';
    const change = { tool: OtaSetupTools.host, ...scope, projectAppId };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Host OTA updates for this app',
      ask: async () =>
        await Promise.resolve(
          [
            'Host OTA updates for this app on Mocco, as you?',
            `App: ${projectApp?.name ?? projectAppId} (${projectAppId})`,
            'Mocco gives it a manifest URL, fixed from now on. Nothing is served until a signed release is promoted to a channel.',
          ].join('\n'),
        ),
      apply: async () => {
        const app = await setup.hosting.createApp(scope.workspaceId, scope.projectId, userId, projectAppId);
        return asJson({
          changed: true,
          appId: app.id,
          manifestUrl: app.manifestUrl,
          updates: updatesBlockOf(app, DEFAULT_SIGNING_KEY_ID),
          next: missingSteps({ channels: [], certificates: [], trustPolicies: [] }),
        });
      },
    });
  } catch (error) {
    return setupRefusal(error);
  }
}

export async function createOtaChannel(
  deps: OtaSetupToolDeps,
  args: CreateOtaChannelArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openSetup(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, setup } = opened;
    const { app, name } = await hostedApp(deps, setup, userId, { ...args, workspaceId });
    const change = { tool: OtaSetupTools.createChannel, workspaceId, appId: app.id, name: args.name };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Add this channel',
      ask: async () =>
        await Promise.resolve(
          [
            'Add an OTA channel, as you?',
            `App: ${name} (${app.id})`,
            `Channel: ${args.name}`,
            'It is open: promotions to it apply at once. Protect it in the console if they should wait for approval.',
          ].join('\n'),
        ),
      apply: async () => {
        const channel = await setup.hosting.createChannel(app, userId, { name: args.name, policy: null });
        return asJson({ changed: true, channel: channelSummary(channel) });
      },
    });
  } catch (error) {
    return setupRefusal(error);
  }
}

export async function addOtaCertificate(
  deps: OtaSetupToolDeps,
  args: AddOtaCertificateArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openSetup(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, setup } = opened;
    // The console's rule: a certificate decides whose signatures devices accept.
    await deps.scope.requireAdmin(userId, workspaceId);
    const { app, name } = await hostedApp(deps, setup, userId, { ...args, workspaceId });
    if (/PRIVATE KEY/u.test(args.certificatePem)) {
      return refused(
        'That is a private key. Send only the certificate (`certs/certificate.pem`); the private key stays in CI.',
      );
    }
    const certificatePem = args.certificatePem.trim();
    const change = {
      tool: OtaSetupTools.addCertificate,
      workspaceId,
      appId: app.id,
      keyid: args.keyid,
      certificatePem,
    };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Register this certificate',
      ask: async () =>
        await Promise.resolve(
          [
            'Register a code signing certificate, as you?',
            `App: ${name} (${app.id})`,
            `keyid: ${args.keyid}`,
            'From now on Mocco accepts updates signed by its private key, and devices that embed it verify them.',
          ].join('\n'),
        ),
      apply: async () => {
        const certificate = await setup.signing.add(app, userId, { certificatePem, keyid: args.keyid });
        return asJson({ changed: true, certificate: certificateSummary(certificate) });
      },
    });
  } catch (error) {
    return setupRefusal(error);
  }
}

export async function trustOtaRepository(
  deps: OtaSetupToolDeps,
  args: TrustOtaRepositoryArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openSetup(deps, ctx, args.workspaceId);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations, setup } = opened;
    // The console's rule: trusting a repository lets its jobs upload without a key.
    await deps.scope.requireAdmin(userId, workspaceId);
    const { app, name } = await hostedApp(deps, setup, userId, { ...args, workspaceId });
    const policy = {
      repositoryId: args.repositoryId,
      repository: args.repository,
      refPattern: args.refPattern,
      workflowRef: args.workflowRef,
      environment: args.environment,
      allowedChannels: args.allowedChannels,
    };
    const change = { tool: OtaSetupTools.trustRepository, workspaceId, appId: app.id, ...policy };
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Trust this repository',
      ask: async () =>
        await Promise.resolve(
          [
            'Trust a GitHub repository to publish OTA updates without a stored key, as you?',
            `App: ${name} (${app.id})`,
            `Repository: ${policy.repository} (id ${policy.repositoryId})`,
            `Ref: ${policy.refPattern}`,
            `Workflow: ${policy.workflowRef ?? 'any'}`,
            `Environment: ${policy.environment ?? 'any'}`,
            `May promote to: ${policy.allowedChannels.length === 0 ? 'no channel (upload only)' : policy.allowedChannels.join(', ')}`,
            'Its jobs still need the signing key: Mocco refuses an upload whose signature does not verify.',
          ].join('\n'),
        ),
      apply: async () => {
        const created = await setup.trustPolicies.create(app, userId, policy);
        return asJson({ changed: true, trustPolicy: { id: created.id, ...policy } });
      },
    });
  } catch (error) {
    return setupRefusal(error);
  }
}

const CHANGE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const SCOPE_CHALLENGE = requireScope(
  McpScopes.otaWrite,
  'Setting up OTA hosting needs your permission for this app to make changes as you',
);
const CONFIRMED =
  'The person is asked to confirm in their client first. Only works where the workspace allows agents to make changes.';

export function registerOtaSetupTools(server: McpServer, deps: OtaSetupToolDeps): void {
  server.registerTool(
    OtaSetupTools.get,
    {
      title: 'Read OTA hosting setup',
      description:
        "A project's React Native apps and, for each one Mocco hosts, its manifest URL and `expo.updates` block, channels, signing certificates and trusted repositories, and what is still missing before the first update. Read-only.",
      inputSchema: setupInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      try {
        return asJson(await getOtaSetup(deps, args, userIdOf(ctx)));
      } catch (error) {
        return setupRefusal(error);
      }
    },
  );

  server.registerTool(
    OtaSetupTools.host,
    {
      title: 'Host OTA updates for an app',
      description: `Host OTA updates on Mocco for a React Native app of the project, as the signed-in person, and answer its manifest URL and the \`expo.updates\` block for app.json. ${CONFIRMED}`,
      inputSchema: hostInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await hostOtaApp(deps, args, ctx),
  );

  server.registerTool(
    OtaSetupTools.createChannel,
    {
      title: 'Add an OTA channel',
      description: `Add an open channel (such as \`staging\` or \`production\`) to a hosted OTA app, as the signed-in person. Protecting it stays in the console. ${CONFIRMED}`,
      inputSchema: channelInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await createOtaChannel(deps, args, ctx),
  );

  server.registerTool(
    OtaSetupTools.addCertificate,
    {
      title: 'Register an OTA signing certificate',
      description: `Register the code signing certificate a hosted OTA app embeds, so Mocco accepts updates signed by its key, as the signed-in person. Owners and admins only. Never send the private key. ${CONFIRMED}`,
      inputSchema: certificateInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await addOtaCertificate(deps, args, ctx),
  );

  server.registerTool(
    OtaSetupTools.trustRepository,
    {
      title: 'Trust a repository to publish OTA updates',
      description: `Trust a GitHub repository and ref to publish OTA updates from Actions without a stored key (OIDC trusted publishing), and name the open channels it may promote to, as the signed-in person. Owners and admins only. ${CONFIRMED}`,
      inputSchema: trustInput,
      annotations: CHANGE_ANNOTATIONS,
      scopeChallenge: SCOPE_CHALLENGE,
    },
    async (args, ctx) => await trustOtaRepository(deps, args, ctx),
  );
}
