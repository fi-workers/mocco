// The monitor changes an agent can make, as the console's monitor screens make them: create an
// HTTP or TCP monitor, change a monitor's settings, pause, resume and delete one.
//
// Thin adapters (ADR 0025) over `MonitorService`, the service the console's `status` router writes
// through, with the locks and refusals in `status-write.ts`.
//
// What a monitor checks can carry secrets (a URL's credentials or query, a request body, a keyword),
// so nothing here reads a monitor's check out: answers and confirmations show the target's host and
// port only, as the read tools do. Changing a monitor's settings keeps its check unless a new one
// is given, so an agent can change the interval or the locations without ever seeing the URL. A
// heartbeat is not created here: its ping URL holds a token shown once, and a credential must not
// pass through an agent's transcript; the console creates it and shows the URL to the person.
// A heartbeat's period and grace can be changed, since that reveals nothing.
//
// Each confirmation is bound to the monitor as it was shown (its `updatedAt`, its state), so a
// change someone saves meanwhile is asked about afresh; a new monitor is bound to the project's
// monitors, so answering the same confirmation twice creates one.
import {
  httpMonitorSpecSchema,
  IncidentPolicies,
  heartbeatMonitorSpecSchema,
  isProbeSpec,
  MonitorKinds,
  MonitorStates,
  monitorInputSchema,
  monitorComponentSchema,
  MonitorLimits,
  quorumModeSchema,
  incidentPolicySchema,
  tcpMonitorSpecSchema,
} from '@mocco/common/status';
import { z } from 'zod';

import { monitorTargetOf } from '@backend/domain/status/monitor-target';
import { confirmThenApply, refused } from '@backend/transport/mcp/tools/deciding';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';
import { projectArg } from '@backend/transport/mcp/tools/status';
import {
  byText,
  componentName,
  openStatusChange,
  statusRefusal,
  statusWords,
  statusWriteChallenge,
} from '@backend/transport/mcp/tools/status-write';

import type { ProjectInScope } from '@backend/domain/mcp/ProjectScope';
import type { MonitorView } from '@backend/domain/status/MonitorService';
import type { StatusChanges, StatusWriteToolDeps } from '@backend/transport/mcp/tools/status-write';
import type { IncidentPolicy, MonitorComponent, MonitorInput } from '@mocco/common/status';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export const StatusMonitorChangeTools = {
  create: 'mocco_status_monitor_create',
  update: 'mocco_status_monitor_update',
  pause: 'mocco_status_monitor_pause',
  resume: 'mocco_status_monitor_resume',
  delete: 'mocco_status_monitor_delete',
} as const;

const monitorArg = z.uuid().describe('The monitor, as `mocco_status_monitors_search` returns it.');
const fields = monitorInputSchema.shape;

const settingArgs = {
  intervalSeconds: z
    .int()
    .min(MonitorLimits.minIntervalSeconds)
    .max(MonitorLimits.maxIntervalSeconds)
    .describe('Seconds between rounds, 60 or more. Probe kinds only.'),
  confirmations: z
    .int()
    .min(1)
    .max(MonitorLimits.maxConfirmations)
    .describe('Failing rounds in a row before it is down.'),
  recoveryConfirmations: z
    .int()
    .min(1)
    .max(MonitorLimits.maxConfirmations)
    .describe('Passing rounds in a row before it is up again.'),
  quorumMode: quorumModeSchema.describe('How locations agree on a round: `majority`, `any` or `all`.'),
  locationIds: z
    .array(z.uuid())
    .min(1)
    .max(MonitorLimits.maxLocations)
    .describe('Where it runs, by id as `mocco_status_locations_search` gives them. Probe kinds only.'),
  components: z
    .array(monitorComponentSchema)
    .max(MonitorLimits.maxComponents)
    .describe(
      'The components it reports on and what they show while it is down, by id as `mocco_status_pages_get` gives them.',
    ),
  incidentPolicy: incidentPolicySchema.describe(
    'When it goes down: `none`, a `draft` incident only your team sees (the default), or `publish` a public one.',
  ),
};

const newMonitorInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  name: fields.name.describe('The name the console shows.'),
  spec: z
    .discriminatedUnion('kind', [httpMonitorSpecSchema, tcpMonitorSpecSchema])
    .describe(
      'What it checks: `{ kind: "http", url, method?, expectedStatus?, keyword?, latencyThresholdMs?, timeoutMs? }` or `{ kind: "tcp", host, port, timeoutMs? }`. A heartbeat is created in the console, which shows its ping URL once.',
    ),
  intervalSeconds: settingArgs.intervalSeconds.default(MonitorLimits.minIntervalSeconds),
  confirmations: settingArgs.confirmations.default(MonitorLimits.defaultConfirmations),
  recoveryConfirmations: settingArgs.recoveryConfirmations.default(MonitorLimits.defaultConfirmations),
  quorumMode: settingArgs.quorumMode.optional(),
  locationIds: settingArgs.locationIds,
  components: settingArgs.components.default([]),
  incidentPolicy: settingArgs.incidentPolicy.default(IncidentPolicies.draft),
});

const updateInput = z.object({
  workspaceId: workspaceArg,
  projectId: projectArg,
  monitorId: monitorArg,
  name: fields.name.optional(),
  spec: z
    .discriminatedUnion('kind', [httpMonitorSpecSchema, tcpMonitorSpecSchema, heartbeatMonitorSpecSchema])
    .optional()
    .describe(
      'A new check, replacing the one it has (an HTTP or TCP check stays a probe kind, a heartbeat a heartbeat: `{ kind: "heartbeat", periodSeconds, graceSeconds }`). Omit it to keep the check, which is never shown.',
    ),
  intervalSeconds: settingArgs.intervalSeconds.optional(),
  confirmations: settingArgs.confirmations.optional(),
  recoveryConfirmations: settingArgs.recoveryConfirmations.optional(),
  quorumMode: settingArgs.quorumMode.optional(),
  locationIds: settingArgs.locationIds.optional(),
  components: settingArgs.components.optional(),
  incidentPolicy: settingArgs.incidentPolicy.optional(),
});

const monitorOnlyInput = z.object({ workspaceId: workspaceArg, projectId: projectArg, monitorId: monitorArg });

export type CreateMonitorArgs = z.infer<typeof newMonitorInput>;
export type UpdateMonitorArgs = z.infer<typeof updateInput>;
export type MonitorOnlyArgs = z.infer<typeof monitorOnlyInput>;

type LinkedMonitor = MonitorView & { locationIds: string[]; components: MonitorComponent[] };

const policyWords: Record<IncidentPolicy, string> = {
  [IncidentPolicies.none]: 'none: going down opens no incident',
  [IncidentPolicies.draft]: 'draft: going down opens an incident only your team sees',
  [IncidentPolicies.publish]: 'publish: going down opens a PUBLIC incident on the page, sent to its subscribers',
};

/** The names a confirmation shows: the workspace's locations and the project's components. */
async function namesFor(changes: StatusChanges, scope: ProjectInScope) {
  const [locations, pages] = await Promise.all([
    changes.locations.list(scope.workspaceId),
    changes.pages.listPages(scope),
  ]);
  const read = await Promise.all(pages.map(async page => await changes.pages.getPage(scope, page.id)));
  return {
    locations: new Map(locations.map(location => [location.id, location] as const)),
    components: new Map(read.flatMap(({ components }) => components.map(each => [each.id, each] as const))),
  };
}

type Names = Awaited<ReturnType<typeof namesFor>>;

const locationLine = (ids: readonly string[], names: Names) =>
  ids.length === 0
    ? 'none'
    : ids
        .map(id => {
          const location = names.locations.get(id);
          return location === undefined ? id : `${location.name} (${location.code})`;
        })
        .join(', ');

const componentLine = (components: readonly MonitorComponent[], names: Names) =>
  components.length === 0
    ? 'none'
    : components
        .map(each => `${componentName(names.components, each.componentId)} (${each.impactWhenDown} while down)`)
        .join(', ');

const methodOf = (spec: MonitorInput['spec']) => (spec.kind === MonitorKinds.http ? ` (${spec.method})` : '');

/** What a monitor's settings say, line by line, never its URL path, query, body or keyword. */
function settingLines(input: MonitorInput, names: Names) {
  const { spec } = input;
  const check =
    spec.kind === MonitorKinds.heartbeat
      ? [`Heartbeat: a ping at least every ${String(spec.periodSeconds)}s, with ${String(spec.graceSeconds)}s grace`]
      : [
          `Checks: ${spec.kind} ${monitorTargetOf(spec) ?? 'no target'}${methodOf(spec)}`,
          `Every ${String(input.intervalSeconds)}s; down after ${String(input.confirmations)} failing rounds, up after ${String(input.recoveryConfirmations)} passing; quorum ${input.quorumMode}`,
          `Runs at: ${locationLine(input.locationIds, names)}`,
        ];
  return [
    `Name: ${input.name}`,
    ...check,
    `Reports on: ${componentLine(input.components, names)}`,
    `Incident policy: ${policyWords[input.incidentPolicy]}`,
  ];
}

/** A monitor as the answers show it: the target's host and port, never its check. */
const monitorSummary = (monitor: MonitorView) => ({
  id: monitor.id,
  name: monitor.name,
  kind: monitor.kind,
  target: monitorTargetOf(monitor.spec),
  state: monitor.state,
  incidentPolicy: monitor.incidentPolicy,
});

export async function createMonitor(
  deps: StatusWriteToolDeps,
  args: CreateMonitorArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('change monitors', 'Creating a monitor'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const input = monitorInputSchema.parse({
      name: args.name,
      spec: args.spec,
      intervalSeconds: args.intervalSeconds,
      confirmations: args.confirmations,
      recoveryConfirmations: args.recoveryConfirmations,
      quorumMode: args.quorumMode,
      locationIds: args.locationIds,
      components: args.components,
      incidentPolicy: args.incidentPolicy,
    });
    const [monitors, names] = await Promise.all([changes.monitors.list(scope), namesFor(changes, scope)]);
    // Bound to the project's monitors: once this one exists, the same answer is refused.
    const change = {
      tool: StatusMonitorChangeTools.create,
      ...scope,
      monitorIds: monitors.map(monitor => monitor.id).toSorted(byText),
      input,
    };
    const question = [
      'Create this monitor, as you?',
      ...settingLines(input, names),
      'Its first round is due at once.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Create this monitor',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // A probe monitor has no ping token; the answer never carries one anyway.
        const created = await changes.monitors.create(scope, userId, input);
        return asJson({ created: true, monitor: monitorSummary(created) });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** The monitor's settings as an input, so a change can name only what it changes. */
function inputOf(monitor: LinkedMonitor): MonitorInput {
  const spec = isProbeSpec(monitor.spec)
    ? monitor.spec
    : {
        kind: MonitorKinds.heartbeat,
        periodSeconds: monitor.heartbeatPeriodSeconds ?? 0,
        graceSeconds: monitor.heartbeatGraceSeconds ?? 0,
      };
  return {
    name: monitor.name,
    spec,
    // A heartbeat's interval is its period, which may be longer than a probe's longest interval.
    intervalSeconds: isProbeSpec(monitor.spec) ? monitor.intervalSeconds : MonitorLimits.minIntervalSeconds,
    confirmations: monitor.confirmations,
    recoveryConfirmations: monitor.recoveryConfirmations,
    quorumMode: monitor.quorumMode,
    locationIds: monitor.locationIds,
    components: monitor.components,
    incidentPolicy: monitor.incidentPolicy,
  };
}

const isCheckLine = (line: string) => /Checks:|Heartbeat:/u.test(line);
const isSet = (value: unknown) => value !== undefined;

/** The lines that differ between two settings, as "before → after". */
function differences(before: readonly string[], after: readonly string[]) {
  return after.flatMap((line, index) => {
    const was = before[index];
    return was === line ? [] : [`${was ?? ''} → ${line}`];
  });
}

export async function updateMonitor(
  deps: StatusWriteToolDeps,
  args: UpdateMonitorArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('change monitors', 'Changing a monitor'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const monitor = await changes.monitors.find(scope, args.monitorId);
    const current = inputOf(monitor);
    const notSettings = new Set(['workspaceId', 'projectId', 'monitorId']);
    const defined = Object.fromEntries(
      Object.entries(args).filter(([key, value]) => !notSettings.has(key) && isSet(value)),
    );
    const input = monitorInputSchema.parse({ ...current, ...defined });
    if (isProbeSpec(input.spec) !== isProbeSpec(monitor.spec)) {
      return refused('A monitor stays a heartbeat or a probe check; create a new monitor to switch.');
    }
    const names = await namesFor(changes, scope);
    const before = settingLines(current, names);
    const after = settingLines(input, names);
    const changed = differences(before, after);
    const isNewCheck = args.spec !== undefined;
    if (changed.length === 0 && !isNewCheck) {
      return asJson({ changed: false, monitorId: monitor.id, reason: 'Its settings are exactly these already.' });
    }
    // Bound to the monitor as shown: a change saved meanwhile moves `updatedAt`.
    const change = {
      tool: StatusMonitorChangeTools.update,
      ...scope,
      monitorId: monitor.id,
      updatedAt: monitor.updatedAt.toISOString(),
      asked: defined,
    };
    const question = [
      `Change monitor "${monitor.name}" (${monitor.id}), as you?`,
      ...changed,
      ...(isNewCheck && changed.every(line => !isCheckLine(line))
        ? ['Its check is replaced (the same target, other details).']
        : []),
      `Its state (${monitor.state}) is kept.`,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Change this monitor',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const updated = await changes.monitors.update(scope, userId, monitor.id, input);
        return asJson({ changed: true, monitor: monitorSummary(updated) });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

/** Pause or resume: what each says, and the state it leaves alone. */
const stateChanges = {
  pause: {
    tool: StatusMonitorChangeTools.pause,
    verb: 'Pause',
    isAlready: (monitor: MonitorView) => monitor.state === MonitorStates.paused,
    already: 'It is paused already.',
    after: 'It stops checking, and its components stop counting it, until it is resumed.',
  },
  resume: {
    tool: StatusMonitorChangeTools.resume,
    verb: 'Resume',
    isAlready: (monitor: MonitorView) => monitor.state !== MonitorStates.paused,
    already: 'It is not paused.',
    after: 'It is pending until its next verdict, and a round is due at once.',
  },
} as const;

async function changeState(
  deps: StatusWriteToolDeps,
  args: MonitorOnlyArgs,
  ctx: ServerContext,
  which: keyof typeof stateChanges,
): Promise<CallToolResult | InputRequiredResult> {
  const words = stateChanges[which];
  try {
    const opened = await openStatusChange(
      deps,
      ctx,
      args,
      statusWords('change monitors', `${words.verb.slice(0, -1)}ing a monitor`),
    );
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const monitor = await changes.monitors.find(scope, args.monitorId);
    if (words.isAlready(monitor)) {
      return asJson({ changed: false, monitorId: monitor.id, state: monitor.state, reason: words.already });
    }
    const change = { tool: words.tool, ...scope, monitorId: monitor.id, from: monitor.state };
    const question = [
      `${words.verb} monitor "${monitor.name}" (${monitor.kind}, ${monitorTargetOf(monitor.spec) ?? 'pinged by its job'}), as you?`,
      `Now: ${monitor.state}`,
      words.after,
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: `${words.verb} this monitor`,
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const changed =
          which === 'pause'
            ? await changes.monitors.pause(scope, userId, monitor.id)
            : await changes.monitors.resume(scope, userId, monitor.id);
        return asJson({ changed: true, monitor: monitorSummary(changed) });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

export const pauseMonitor = async (deps: StatusWriteToolDeps, args: MonitorOnlyArgs, ctx: ServerContext) =>
  await changeState(deps, args, ctx, 'pause');
export const resumeMonitor = async (deps: StatusWriteToolDeps, args: MonitorOnlyArgs, ctx: ServerContext) =>
  await changeState(deps, args, ctx, 'resume');

export async function deleteMonitor(
  deps: StatusWriteToolDeps,
  args: MonitorOnlyArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openStatusChange(deps, ctx, args, statusWords('change monitors', 'Deleting a monitor'));
    if ('content' in opened) {
      return opened;
    }
    const { userId, scope, confirmations, changes } = opened;
    const monitor = await changes.monitors.find(scope, args.monitorId);
    const change = {
      tool: StatusMonitorChangeTools.delete,
      ...scope,
      monitorId: monitor.id,
      updatedAt: monitor.updatedAt.toISOString(),
    };
    const question = [
      `Delete monitor "${monitor.name}" (${monitor.kind}, ${monitorTargetOf(monitor.spec) ?? 'pinged by its job'}), as you?`,
      `Now: ${monitor.state}`,
      'Its settings, state changes, rounds and uptime history are deleted, and its components stop counting it. Incidents it opened stay. It cannot be undone.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Delete this monitor',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await changes.monitors.delete(scope, userId, monitor.id);
        return asJson({ changed: true, deletedMonitorId: monitor.id });
      },
    });
  } catch (error) {
    return statusRefusal(error);
  }
}

const CONFIRMED =
  'The person is asked to confirm in their client first, and it only works where the workspace allows agents to make changes.';
const changing = { readOnlyHint: false, openWorldHint: false } as const;

export function registerStatusMonitorChangeTools(server: McpServer, deps: StatusWriteToolDeps): void {
  server.registerTool(
    StatusMonitorChangeTools.create,
    {
      title: 'Create a monitor',
      description: `Create an HTTP or TCP monitor of a project as the signed-in person: what it checks, how often, where it runs, the components it reports on and what going down does. A heartbeat is created in the console, which shows its ping URL once. ${CONFIRMED}`,
      inputSchema: newMonitorInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: false },
      scopeChallenge: statusWriteChallenge('Creating a monitor'),
    },
    async (args, ctx) => await createMonitor(deps, args, ctx),
  );

  server.registerTool(
    StatusMonitorChangeTools.update,
    {
      title: "Change a monitor's settings",
      description: `Change a monitor's settings as the signed-in person, naming only what changes; its check is kept unless a new one is given, and never shown. Its state is kept. ${CONFIRMED}`,
      inputSchema: updateInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Changing a monitor'),
    },
    async (args, ctx) => await updateMonitor(deps, args, ctx),
  );

  server.registerTool(
    StatusMonitorChangeTools.pause,
    {
      title: 'Pause a monitor',
      description: `Stop a monitor checking until it is resumed, as the signed-in person; a paused one answers without asking. ${CONFIRMED}`,
      inputSchema: monitorOnlyInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Pausing a monitor'),
    },
    async (args, ctx) => await pauseMonitor(deps, args, ctx),
  );

  server.registerTool(
    StatusMonitorChangeTools.resume,
    {
      title: 'Resume a monitor',
      description: `Start a paused monitor checking again, as the signed-in person; it is pending until its next verdict. ${CONFIRMED}`,
      inputSchema: monitorOnlyInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Resuming a monitor'),
    },
    async (args, ctx) => await resumeMonitor(deps, args, ctx),
  );

  server.registerTool(
    StatusMonitorChangeTools.delete,
    {
      title: 'Delete a monitor',
      description: `Delete a monitor with its history, as the signed-in person; incidents it opened stay. It cannot be undone. ${CONFIRMED}`,
      inputSchema: monitorOnlyInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: statusWriteChallenge('Deleting a monitor'),
    },
    async (args, ctx) => await deleteMonitor(deps, args, ctx),
  );
}
