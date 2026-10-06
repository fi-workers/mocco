// Create or edit a monitor (#150): an HTTP or TCP check, how often it runs and how many rounds
// confirm a change, the probe locations that run it, the components it reports on with what
// they show while it is down, and whether going down opens an incident. A heartbeat (#153) has
// a period and a grace instead of a check, interval, confirmations and locations, and creating
// one shows its ping URL once. The input is parsed with the same `monitorInputSchema` the server
// uses, and a refused save shows the server's error.
import {
  HeartbeatLimits,
  HttpMonitorMethods,
  IncidentPolicies,
  incidentPolicySchema,
  KeywordModes,
  LocationKinds,
  monitorInputSchema,
  MonitorKinds,
  MonitorLimits,
  QuorumModes,
  quorumModeSchema,
} from '@mocco/common/status';
import { useId, useState } from 'react';
import { z } from 'zod';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import AffectedComponentsPicker from '@frontend/components/status/affected-components';
import { HeartbeatPingOnce } from '@frontend/components/status/heartbeat-ping';
import { useProjectComponents } from '@frontend/components/status/project-components';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';
import type {
  AffectedComponent,
  HttpMonitorMethod,
  IncidentPolicy,
  KeywordMode,
  LocationDto,
  MonitorInput,
  MonitorKind,
  QuorumMode,
} from '@mocco/common/status';

export type Monitor = StatusOutputs['monitors']['monitors'][number];

interface Props {
  workspaceId: string;
  projectId: string;
  /** The monitor being edited; a new one otherwise. */
  monitor?: Monitor;
  onDone: () => void;
}

const methodSchema = z.enum(HttpMonitorMethods);
const keywordModeSchema = z.enum(KeywordModes);
const kindSchema = z.enum(MonitorKinds);
/** The keyword rule: none, or the body must contain it, or must not. */
const NO_KEYWORD = '';

const incidentPolicyLabels: Readonly<Record<IncidentPolicy, string>> = {
  [IncidentPolicies.none]: 'Open no incident',
  [IncidentPolicies.draft]: 'Open a draft incident (default)',
  [IncidentPolicies.publish]: 'Open a published incident',
};

const quorumLabels: Readonly<Record<QuorumMode, string>> = {
  [QuorumModes.majority]: 'Most of them (default)',
  [QuorumModes.any]: 'Any one',
  [QuorumModes.all]: 'All of them',
};

const locationKindLabels: Readonly<Record<LocationDto['kind'], string>> = {
  [LocationKinds.hosted]: 'Hosted',
  [LocationKinds.private]: 'Private',
  [LocationKinds.embedded]: 'This server',
};

/** The form's fields as typed, before parsing. */
interface Fields {
  name: string;
  kind: MonitorKind;
  url: string;
  method: HttpMonitorMethod;
  body: string;
  expectedStatus: string;
  keywordMode: KeywordMode | typeof NO_KEYWORD;
  keyword: string;
  latencyThresholdMs: string;
  tlsWarnDays: string;
  timeoutSeconds: string;
  followRedirects: boolean;
  host: string;
  port: string;
  /** A heartbeat's period and grace, in minutes. */
  periodMinutes: string;
  graceMinutes: string;
  intervalSeconds: string;
  confirmations: string;
  recoveryConfirmations: string;
  quorumMode: QuorumMode;
  incidentPolicy: IncidentPolicy;
  locationIds: string[];
  components: AffectedComponent[];
}

function fieldsOf(monitor: Monitor | undefined): Fields {
  const spec = monitor?.spec;
  const http = spec?.kind === MonitorKinds.http ? spec : undefined;
  const tcp = spec?.kind === MonitorKinds.tcp ? spec : undefined;
  return {
    name: monitor?.name ?? '',
    kind: spec?.kind ?? MonitorKinds.http,
    url: http?.url ?? '',
    method: http?.method ?? HttpMonitorMethods.GET,
    body: http?.body ?? '',
    expectedStatus: http?.expectedStatus.join(', ') ?? '',
    keywordMode: http?.keyword === undefined ? NO_KEYWORD : http.keywordMode,
    keyword: http?.keyword ?? '',
    latencyThresholdMs: http?.latencyThresholdMs === undefined ? '' : String(http.latencyThresholdMs),
    tlsWarnDays: http?.tlsWarnDays === undefined ? '' : String(http.tlsWarnDays),
    timeoutSeconds: String(((http ?? tcp)?.timeoutMs ?? MonitorLimits.defaultTimeoutMs) / 1000),
    followRedirects: http?.followRedirects ?? true,
    host: tcp?.host ?? '',
    port: tcp === undefined ? '' : String(tcp.port),
    periodMinutes: String((monitor?.heartbeatPeriodSeconds ?? HeartbeatLimits.defaultPeriodSeconds) / 60),
    graceMinutes: String((monitor?.heartbeatGraceSeconds ?? HeartbeatLimits.defaultGraceSeconds) / 60),
    intervalSeconds: String(monitor?.intervalSeconds ?? MonitorLimits.minIntervalSeconds),
    confirmations: String(monitor?.confirmations ?? MonitorLimits.defaultConfirmations),
    recoveryConfirmations: String(monitor?.recoveryConfirmations ?? MonitorLimits.defaultConfirmations),
    quorumMode: monitor?.quorumMode ?? QuorumModes.majority,
    incidentPolicy: monitor?.incidentPolicy ?? IncidentPolicies.draft,
    locationIds: monitor?.locationIds ?? [],
    components: (monitor?.components ?? []).map(link => ({
      componentId: link.componentId,
      impact: link.impactWhenDown,
    })),
  };
}

/** A number typed in a field; blank or not a number is NaN, which the schema refuses. */
// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const numberOf = (value: string): number => (value.trim() === '' ? NaN : Number(value));

/** The spec the fields describe: an HTTP or TCP check, or a heartbeat's period and grace. */
function specOf(fields: Fields) {
  const timeoutMs = Math.round(numberOf(fields.timeoutSeconds) * 1000);
  if (fields.kind === MonitorKinds.heartbeat) {
    return {
      kind: MonitorKinds.heartbeat,
      periodSeconds: Math.round(numberOf(fields.periodMinutes) * 60),
      graceSeconds: Math.round(numberOf(fields.graceMinutes) * 60),
    };
  }
  return fields.kind === MonitorKinds.tcp
    ? { kind: MonitorKinds.tcp, host: fields.host, port: numberOf(fields.port), timeoutMs }
    : {
        kind: MonitorKinds.http,
        url: fields.url.trim(),
        method: fields.method,
        ...(fields.method === HttpMonitorMethods.POST && fields.body !== '' && { body: fields.body }),
        expectedStatus: fields.expectedStatus
          .split(/[\s,]+/u)
          .filter(code => code !== '')
          .map(Number),
        ...(fields.keywordMode !== NO_KEYWORD && { keyword: fields.keyword, keywordMode: fields.keywordMode }),
        ...(fields.latencyThresholdMs.trim() !== '' && { latencyThresholdMs: numberOf(fields.latencyThresholdMs) }),
        ...(fields.tlsWarnDays.trim() !== '' && { tlsWarnDays: numberOf(fields.tlsWarnDays) }),
        timeoutMs,
        followRedirects: fields.followRedirects,
      };
}

/** The monitor input the fields describe, parsed with the server's schema. */
function parseFields(fields: Fields) {
  const isHeartbeat = fields.kind === MonitorKinds.heartbeat;
  return monitorInputSchema.safeParse({
    name: fields.name,
    spec: specOf(fields),
    intervalSeconds: numberOf(fields.intervalSeconds),
    confirmations: numberOf(fields.confirmations),
    recoveryConfirmations: numberOf(fields.recoveryConfirmations),
    quorumMode: fields.quorumMode,
    incidentPolicy: fields.incidentPolicy,
    // A heartbeat has no locations; ones ticked before switching the kind don't count.
    locationIds: isHeartbeat ? [] : fields.locationIds,
    components: fields.components.map(link => ({ componentId: link.componentId, impactWhenDown: link.impact })),
  });
}

/** The first problem with the fields, named after the field. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues.at(0);
  if (issue === undefined) {
    return 'Check the fields.';
  }
  const field = issue.path
    .map(String)
    .filter(part => part !== 'spec')
    .join('.');
  return field === '' ? issue.message : `${field}: ${issue.message}`;
}

/** The locations a monitor can be assigned to: enabled ones, and any it already uses. */
function LocationsField({
  locations,
  value,
  onChange,
}: {
  locations: readonly LocationDto[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const offered = locations.filter(location => location.disabledAt === null || value.includes(location.id));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">Locations</legend>
      {offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No probe locations yet. An owner or admin creates a private location and runs the probe there.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {offered.map(location => (
            <li key={location.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.includes(location.id)}
                  onChange={event => {
                    onChange(event.target.checked ? [...value, location.id] : value.filter(id => id !== location.id));
                  }}
                />
                {location.name}
                <span className="font-mono text-xs text-muted-foreground">{location.code}</span>
                <span className="text-xs text-muted-foreground">
                  {location.disabledAt === null ? locationKindLabels[location.kind] : 'Disabled'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        type="number"
        inputMode="numeric"
        className={`${inputClass} w-32`}
        value={value}
        min={min}
        max={max}
        onChange={event => {
          onChange(event.target.value);
        }}
      />
      {hint === undefined ? null : <span className="font-normal">{hint}</span>}
    </label>
  );
}

function HttpFields({ fields, set }: { fields: Fields; set: (patch: Partial<Fields>) => void }) {
  return (
    <>
      <div className="flex flex-wrap gap-4">
        <label className={labelClass}>
          Method
          <select
            className={inputClass}
            value={fields.method}
            onChange={event => {
              const parsed = methodSchema.safeParse(event.target.value);
              if (parsed.success) {
                set({ method: parsed.data });
              }
            }}>
            {Object.values(HttpMonitorMethods).map(method => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelClass} min-w-64 flex-1`}>
          URL
          <input
            className={`${inputClass} font-mono`}
            placeholder="https://api.example.com/health"
            value={fields.url}
            maxLength={MonitorLimits.urlMax}
            onChange={event => {
              set({ url: event.target.value });
            }}
          />
        </label>
      </div>
      {fields.method === HttpMonitorMethods.POST ? (
        <label className={labelClass}>
          Request body
          <textarea
            className={`${inputClass} h-20 py-1.5 font-mono`}
            value={fields.body}
            maxLength={MonitorLimits.requestBodyMax}
            onChange={event => {
              set({ body: event.target.value });
            }}
          />
        </label>
      ) : null}
      <label className={labelClass}>
        Expected status codes
        <input
          className={`${inputClass} w-64 font-mono`}
          placeholder="200, 204"
          value={fields.expectedStatus}
          onChange={event => {
            set({ expectedStatus: event.target.value });
          }}
        />
        <span className="font-normal">Separate codes with commas. Leave it empty to accept any 2xx.</span>
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <label className={labelClass}>
          Keyword
          <select
            className={inputClass}
            value={fields.keywordMode}
            onChange={event => {
              const parsed = keywordModeSchema.safeParse(event.target.value);
              set({ keywordMode: parsed.success ? parsed.data : NO_KEYWORD });
            }}>
            <option value={NO_KEYWORD}>Don&apos;t check the body</option>
            <option value={KeywordModes.contains}>Body contains</option>
            <option value={KeywordModes.absent}>Body doesn&apos;t contain</option>
          </select>
        </label>
        {fields.keywordMode === NO_KEYWORD ? null : (
          <input
            aria-label="Keyword text"
            className={`${inputClass} min-w-48 flex-1`}
            placeholder="ok"
            value={fields.keyword}
            maxLength={MonitorLimits.keywordMax}
            onChange={event => {
              set({ keyword: event.target.value });
            }}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-4">
        <NumberField
          label="Slow above (ms)"
          value={fields.latencyThresholdMs}
          min={1}
          max={MonitorLimits.maxTimeoutMs}
          hint="Optional. Slower answers make the monitor degraded."
          onChange={value => {
            set({ latencyThresholdMs: value });
          }}
        />
        <NumberField
          label="Warn before certificate expiry (days)"
          value={fields.tlsWarnDays}
          min={1}
          max={365}
          hint="Optional, https only. Warns once at this many days left, and again at 7, 3 and 1."
          onChange={value => {
            set({ tlsWarnDays: value });
          }}
        />
        <label className="flex items-center gap-2 self-center text-sm">
          <input
            type="checkbox"
            checked={fields.followRedirects}
            onChange={event => {
              set({ followRedirects: event.target.checked });
            }}
          />
          Follow redirects
        </label>
      </div>
    </>
  );
}

function TcpFields({ fields, set }: { fields: Fields; set: (patch: Partial<Fields>) => void }) {
  return (
    <div className="flex flex-wrap gap-4">
      <label className={`${labelClass} min-w-64 flex-1`}>
        Host
        <input
          className={`${inputClass} font-mono`}
          placeholder="db.internal"
          value={fields.host}
          maxLength={253}
          onChange={event => {
            set({ host: event.target.value });
          }}
        />
      </label>
      <NumberField
        label="Port"
        value={fields.port}
        min={1}
        max={65_535}
        onChange={value => {
          set({ port: value });
        }}
      />
    </div>
  );
}

function HeartbeatFields({ fields, set }: { fields: Fields; set: (patch: Partial<Fields>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-4">
        <NumberField
          label="Expected every (min)"
          value={fields.periodMinutes}
          min={HeartbeatLimits.minPeriodSeconds / 60}
          max={HeartbeatLimits.maxPeriodSeconds / 60}
          hint="How often the job runs."
          onChange={value => {
            set({ periodMinutes: value });
          }}
        />
        <NumberField
          label="Grace (min)"
          value={fields.graceMinutes}
          min={HeartbeatLimits.minGraceSeconds / 60}
          max={HeartbeatLimits.maxGraceSeconds / 60}
          hint="How late a ping may be."
          onChange={value => {
            set({ graceMinutes: value });
          }}
        />
      </div>
      <p className="max-w-prose text-xs text-muted-foreground">
        The job pings Mocco when it finishes. With no ping for the period plus the grace, or a ping that reports a
        failure, the monitor is down at once; the next successful ping brings it back up.
      </p>
    </div>
  );
}

/** The kinds a monitor may be: any for a new one; an existing one stays a heartbeat or a probe check. */
function kindsFor(monitor: Monitor | undefined): MonitorKind[] {
  const probes = [MonitorKinds.http, MonitorKinds.tcp];
  if (monitor === undefined) {
    return [...probes, MonitorKinds.heartbeat];
  }
  return monitor.kind === MonitorKinds.heartbeat ? [MonitorKinds.heartbeat] : probes;
}

const kindLabels: Readonly<Record<MonitorKind, string>> = {
  [MonitorKinds.http]: 'HTTP',
  [MonitorKinds.tcp]: 'TCP',
  [MonitorKinds.heartbeat]: 'Heartbeat',
};

/** A probe monitor's timeout, interval, confirmations, locations and quorum. */
function ProbeSettings({
  workspaceId,
  fields,
  set,
}: {
  workspaceId: string;
  fields: Fields;
  set: (patch: Partial<Fields>) => void;
}) {
  const locationsQuery = trpc.status.locations.useQuery({ workspaceId });
  return (
    <>
      <div className="flex flex-wrap gap-4">
        <NumberField
          label="Timeout (s)"
          value={fields.timeoutSeconds}
          min={1}
          max={MonitorLimits.maxTimeoutMs / 1000}
          onChange={value => {
            set({ timeoutSeconds: value });
          }}
        />
        <NumberField
          label="Every (s)"
          value={fields.intervalSeconds}
          min={MonitorLimits.minIntervalSeconds}
          max={MonitorLimits.maxIntervalSeconds}
          hint="60 or more."
          onChange={value => {
            set({ intervalSeconds: value });
          }}
        />
        <NumberField
          label="Down after (rounds)"
          value={fields.confirmations}
          min={1}
          max={MonitorLimits.maxConfirmations}
          onChange={value => {
            set({ confirmations: value });
          }}
        />
        <NumberField
          label="Up after (rounds)"
          value={fields.recoveryConfirmations}
          min={1}
          max={MonitorLimits.maxConfirmations}
          onChange={value => {
            set({ recoveryConfirmations: value });
          }}
        />
      </div>
      {locationsQuery.data ? (
        <LocationsField
          locations={locationsQuery.data.locations}
          value={fields.locationIds}
          onChange={locationIds => {
            set({ locationIds });
          }}
        />
      ) : (
        <Spinner />
      )}
      {locationsQuery.error ? <p className="text-sm text-destructive">{errorMessage(locationsQuery.error)}</p> : null}
      <label className={labelClass}>
        Locations that must agree
        <select
          className={`${inputClass} w-fit`}
          value={fields.quorumMode}
          onChange={event => {
            const parsed = quorumModeSchema.safeParse(event.target.value);
            if (parsed.success) {
              set({ quorumMode: parsed.data });
            }
          }}>
          {Object.values(QuorumModes).map(mode => (
            <option key={mode} value={mode}>
              {quorumLabels[mode]}
            </option>
          ))}
        </select>
        <span className="font-normal">
          A round fails or passes when this many of the locations that reported agree. Locations that sent nothing
          don&apos;t count.
        </span>
      </label>
    </>
  );
}

export default function MonitorForm({ workspaceId, projectId, monitor, onDone }: Props) {
  const id = useId();
  const utils = trpc.useUtils();
  const [fields, setFields] = useState<Fields>(() => fieldsOf(monitor));
  const [issue, setIssue] = useState<string | null>(null);
  /** A new heartbeat's ping URL, shown once before the form closes. */
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const set = (patch: Partial<Fields>) => {
    setFields(current => ({ ...current, ...patch }));
    setIssue(null);
  };
  const project = useProjectComponents(workspaceId, projectId);
  const refresh = async () => {
    await Promise.all([utils.status.monitors.invalidate(), utils.status.monitor.invalidate()]);
  };
  const onSuccess = async () => {
    await refresh();
    onDone();
  };
  const create = trpc.status.createMonitor.useMutation({
    onSuccess: async result => {
      await refresh();
      if (result.heartbeatToken === null) {
        onDone();
      } else {
        setCreated({ name: result.monitor.name, token: result.heartbeatToken });
      }
    },
  });
  const update = trpc.status.updateMonitor.useMutation({ onSuccess });
  const save = monitor === undefined ? create : update;
  const submit = (input: MonitorInput) => {
    if (monitor === undefined) {
      create.mutate({ workspaceId, projectId, ...input });
    } else {
      update.mutate({ workspaceId, projectId, monitorId: monitor.id, ...input });
    }
  };
  const pagesWithComponents = project.pages.filter(entry => entry.components.length > 0);
  const isHeartbeat = fields.kind === MonitorKinds.heartbeat;

  if (created !== null) {
    return <HeartbeatPingOnce name={created.name} token={created.token} onDone={onDone} />;
  }

  return (
    <form
      aria-label={monitor === undefined ? 'New monitor' : `Edit ${monitor.name}`}
      className="flex max-w-2xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        const parsed = parseFields(fields);
        setIssue(parsed.success ? null : firstIssue(parsed.error));
        if (parsed.success) {
          submit(parsed.data);
        }
      }}>
      <h3 className="text-sm font-medium">{monitor === undefined ? 'New monitor' : `Edit ${monitor.name}`}</h3>
      <div className="flex flex-wrap gap-4">
        <label className={`${labelClass} min-w-64 flex-1`}>
          Name
          <input
            className={inputClass}
            placeholder="API health"
            value={fields.name}
            maxLength={120}
            onChange={event => {
              set({ name: event.target.value });
            }}
          />
        </label>
        <label className={labelClass} htmlFor={`${id}-kind`}>
          Check
          <select
            id={`${id}-kind`}
            className={inputClass}
            value={fields.kind}
            onChange={event => {
              const parsed = kindSchema.safeParse(event.target.value);
              if (parsed.success) {
                set({ kind: parsed.data });
              }
            }}>
            {kindsFor(monitor).map(kind => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fields.kind === MonitorKinds.http ? <HttpFields fields={fields} set={set} /> : null}
      {fields.kind === MonitorKinds.tcp ? <TcpFields fields={fields} set={set} /> : null}
      {isHeartbeat ? <HeartbeatFields fields={fields} set={set} /> : null}
      {isHeartbeat ? null : <ProbeSettings workspaceId={workspaceId} fields={fields} set={set} />}
      {project.isPending ? <Spinner /> : null}
      {!project.isPending && pagesWithComponents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The project&apos;s status pages have no components yet, so this monitor won&apos;t change what a page shows.
        </p>
      ) : null}
      {pagesWithComponents.map(entry => (
        <AffectedComponentsPicker
          key={entry.page.id}
          legend={`While down, on ${entry.page.title}`}
          components={entry.components}
          value={fields.components}
          onChange={components => {
            set({ components });
          }}
        />
      ))}
      <label className={labelClass}>
        When it goes down
        <select
          className={`${inputClass} w-fit`}
          value={fields.incidentPolicy}
          onChange={event => {
            const parsed = incidentPolicySchema.safeParse(event.target.value);
            if (parsed.success) {
              set({ incidentPolicy: parsed.data });
            }
          }}>
          {Object.values(IncidentPolicies).map(policy => (
            <option key={policy} value={policy}>
              {incidentPolicyLabels[policy]}
            </option>
          ))}
        </select>
        <span className="font-normal">
          A draft stays in the console and never reaches the public page. During maintenance a published incident opens
          as a draft.
        </span>
      </label>
      {issue === null ? null : <p className="text-sm text-destructive">{issue}</p>}
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" className="text-sm" pending={save.isPending}>
          {monitor === undefined ? 'Create monitor' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
