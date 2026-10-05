// A project's status page as code (#159): monitors upserted by a key you choose, incidents and
// their updates, maintenance windows and component statuses, from CI or a script, over the
// /v1 status routes. A secret key: reads need `status:read`, changes `status:write`. The wire
// types are written out here (no schema library in the bundle); the backend's contract test
// checks them against the routes' schemas.
//
// A subpath of its own (`@mocco/sdk-core/status`): it is for servers and CI, so the browser
// bundle never carries it. It imports the package's main entry rather than its files, so the
// built subpath shares that entry's `MoccoError` instead of a copy.
import { MoccoError } from '@mocco/sdk-core';

import type { MoccoClient } from '@mocco/sdk-core';

export type StatusComponentStatus = 'operational' | 'maintenance' | 'degraded' | 'partial_outage' | 'major_outage';
export type StatusImpact = 'degraded' | 'partial_outage' | 'major_outage';
export type StatusIncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';
export type StatusIncidentSeverity = 'minor' | 'major' | 'critical';
export type StatusMonitorKind = 'http' | 'tcp' | 'heartbeat';
export type StatusMonitorState = 'pending' | 'up' | 'suspect' | 'down' | 'recovering' | 'degraded' | 'paused';
export type StatusQuorumMode = 'majority' | 'any' | 'all';
export type StatusIncidentPolicy = 'none' | 'draft' | 'publish';

/** What a monitor checks. Omitted fields take Mocco's defaults (GET, any 2xx, a 10 s timeout). */
export type StatusMonitorSpec =
  | {
      kind: 'http';
      url: string;
      method?: 'GET' | 'HEAD' | 'POST';
      body?: string;
      /** The status codes that pass; empty means any 2xx. */
      expectedStatus?: number[];
      keyword?: string;
      keywordMode?: 'contains' | 'absent';
      latencyThresholdMs?: number;
      timeoutMs?: number;
      followRedirects?: boolean;
      tlsWarnDays?: number;
    }
  | { kind: 'tcp'; host: string; port: number; timeoutMs?: number }
  | { kind: 'heartbeat'; periodSeconds?: number; graceSeconds?: number };

/** A monitor as you declare it: the body of `PUT /v1/monitors/by-key/:key`. */
export interface StatusMonitorInput {
  name: string;
  spec: StatusMonitorSpec;
  /** Probe kinds only (60 or more; default 60). */
  intervalSeconds?: number;
  confirmations?: number;
  recoveryConfirmations?: number;
  quorumMode?: StatusQuorumMode;
  /** One or more for a probe kind, none for a heartbeat; `status.locations.idsOf(codes)` finds them. */
  locationIds?: string[];
  components?: { componentId: string; impactWhenDown: StatusImpact }[];
  incidentPolicy?: StatusIncidentPolicy;
}

/** A monitor as Mocco reports it. Its URL beyond the host, its body and its keyword never come back. */
export interface StatusMonitor {
  id: string;
  /** Null for a monitor made in the console. */
  key: string | null;
  name: string;
  kind: StatusMonitorKind;
  /** An HTTP URL's host and port, or a TCP host and port; null for a heartbeat. */
  target: string | null;
  state: StatusMonitorState;
  stateChangedAt: string;
  check: {
    method: string | null;
    expectedStatus: number[];
    latencyThresholdMs: number | null;
    timeoutMs: number;
    followRedirects: boolean | null;
    tlsWarnDays: number | null;
  } | null;
  heartbeat: {
    periodSeconds: number;
    graceSeconds: number;
    lastPingAt: string | null;
    lastStartAt: string | null;
    lastDurationMs: number | null;
  } | null;
  intervalSeconds: number;
  confirmations: number;
  recoveryConfirmations: number;
  quorumMode: StatusQuorumMode;
  incidentPolicy: StatusIncidentPolicy;
  locationIds: string[];
  components: { componentId: string; impactWhenDown: StatusImpact }[];
  createdAt: string;
  updatedAt: string;
}

/** What an upsert did, the monitor as it is now, and a new heartbeat's ping token (this once). */
export interface StatusMonitorUpsertResult {
  outcome: 'created' | 'updated' | 'unchanged';
  monitor: StatusMonitor;
  heartbeatToken: string | null;
}

export interface StatusLocation {
  id: string;
  code: string;
  name: string;
  kind: 'hosted' | 'private' | 'embedded';
  disabled: boolean;
}

export interface StatusPage {
  id: string;
  slug: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StatusComponent {
  id: string;
  pageId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  position: number;
  /** The status set by hand. */
  status: StatusComponentStatus;
  /** What the page shows: the worst of `status`, open incidents, maintenance and linked monitors. */
  displayedStatus: StatusComponentStatus;
  updatedAt: string;
}

export interface StatusIncident {
  id: string;
  pageId: string;
  title: string;
  status: StatusIncidentStatus;
  severity: StatusIncidentSeverity;
  visibility: 'draft' | 'published';
  origin: 'manual' | 'monitor' | 'deploy_watch';
  startedAt: string;
  identifiedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusIncidentUpdate {
  id: string;
  status: StatusIncidentStatus;
  /** Markdown. */
  body: string;
  createdAt: string;
}

export interface StatusAffectedComponent {
  componentId: string;
  impact: StatusImpact;
}

/** An incident with its timeline (oldest first) and the components it affects. */
export interface StatusIncidentDetail {
  incident: StatusIncident;
  updates: StatusIncidentUpdate[];
  components: StatusAffectedComponent[];
}

export interface StatusIncidentCreateRequest {
  pageId: string;
  title: string;
  severity: StatusIncidentSeverity;
  /** The first update's status (default `investigating`; never `resolved`). */
  status?: Exclude<StatusIncidentStatus, 'resolved'>;
  /** The first update, Markdown. */
  body: string;
  components?: StatusAffectedComponent[];
}

export interface StatusIncidentUpdateRequest {
  status: StatusIncidentStatus;
  body: string;
}

export interface StatusMaintenance {
  id: string;
  pageId: string;
  title: string;
  body: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'canceled';
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  componentIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** What `POST /v1/maintenances` takes: the times as ISO 8601 strings. */
export interface StatusMaintenanceRequest {
  pageId: string;
  title: string;
  body?: string;
  scheduledStart: string;
  scheduledEnd: string;
  componentIds?: string[];
}

/** A maintenance window to schedule; the times may be `Date`s. */
export type StatusMaintenanceInput = Omit<StatusMaintenanceRequest, 'scheduledStart' | 'scheduledEnd'> & {
  scheduledStart: Date | string;
  scheduledEnd: Date | string;
};

const seg = (value: string) => encodeURIComponent(value);
const isoOf = (at: Date | string) => (typeof at === 'string' ? at : at.toISOString());

/**
 * `status.*`: build it over a secret-key `MoccoClient` (`createMoccoServer` in `@mocco/node`
 * does). Every method resolves with what the route answers and throws `MoccoError` for a
 * refusal (`code` `insufficient_scope`, `not_found`, `conflict`, …). Reads and the monitor
 * upsert retry on 429 and 5xx; other changes don't.
 */
export class StatusClient {
  // The namespaces read `this.client` only when a method is called, after the constructor ran.
  readonly locations = {
    list: async (): Promise<StatusLocation[]> => {
      const { locations } = await this.client.request<{ locations: StatusLocation[] }>('GET', '/locations');
      return locations;
    },
    /**
     * The ids of the enabled locations with these codes, in order, for `locationIds`. The
     * workspace's own location wins over a shared one with the same code. Throws for an
     * unknown or disabled code.
     */
    idsOf: async (codes: readonly string[]): Promise<string[]> => {
      const all = await this.locations.list();
      const enabled = all.filter(location => !location.disabled);
      return codes.map(code => {
        const matches = enabled.filter(location => location.code === code);
        const found = matches.find(location => location.kind === 'private') ?? matches[0];
        if (found === undefined) {
          throw new MoccoError(404, { title: 'Not found', detail: `No enabled location with the code "${code}"` });
        }
        return found.id;
      });
    },
  };

  readonly monitors = {
    list: async (): Promise<StatusMonitor[]> => {
      const { monitors } = await this.client.request<{ monitors: StatusMonitor[] }>('GET', '/monitors');
      return monitors;
    },
    get: async (monitorId: string): Promise<StatusMonitor> =>
      await this.client.request<StatusMonitor>('GET', `/monitors/${seg(monitorId)}`),
    /**
     * Create the monitor with this key, or change it to match `input`. The same input again
     * answers `unchanged` and changes nothing, so it is safe to run on every deploy.
     */
    upsert: async (key: string, input: StatusMonitorInput): Promise<StatusMonitorUpsertResult> =>
      await this.client.request<StatusMonitorUpsertResult>('PUT', `/monitors/by-key/${seg(key)}`, { body: input }),
    pause: async (monitorId: string): Promise<StatusMonitor> =>
      await this.client.request<StatusMonitor>('POST', `/monitors/${seg(monitorId)}/pause`),
    resume: async (monitorId: string): Promise<StatusMonitor> =>
      await this.client.request<StatusMonitor>('POST', `/monitors/${seg(monitorId)}/resume`),
    delete: async (monitorId: string): Promise<void> => {
      await this.client.request('DELETE', `/monitors/${seg(monitorId)}`);
    },
    /** Run the monitor's next round now (e.g. after a deploy); its verdict follows as for any round. */
    check: async (monitorId: string): Promise<{ monitorId: string; roundAt: string }> =>
      await this.client.request('POST', `/monitors/${seg(monitorId)}/check`),
  };

  readonly pages = {
    list: async (): Promise<StatusPage[]> => {
      const { pages } = await this.client.request<{ pages: StatusPage[] }>('GET', '/pages');
      return pages;
    },
  };

  readonly components = {
    list: async (pageId: string): Promise<StatusComponent[]> => {
      const { components } = await this.client.request<{ components: StatusComponent[] }>(
        'GET',
        `/pages/${seg(pageId)}/components`,
      );
      return components;
    },
    /** Set the status the component reports by hand; open incidents and maintenance still count. */
    setStatus: async (componentId: string, status: StatusComponentStatus): Promise<StatusComponent> =>
      await this.client.request<StatusComponent>('PATCH', `/components/${seg(componentId)}`, { body: { status } }),
  };

  readonly incidents = {
    /** A page's incidents, newest first, drafts included; `open` leaves out resolved ones. */
    list: async (pageId: string, opts: { open?: boolean } = {}): Promise<StatusIncident[]> => {
      const query = new URLSearchParams({ pageId, open: String(opts.open ?? false) });
      const { incidents } = await this.client.request<{ incidents: StatusIncident[] }>('GET', `/incidents?${query}`);
      return incidents;
    },
    get: async (incidentId: string): Promise<StatusIncidentDetail> =>
      await this.client.request<StatusIncidentDetail>('GET', `/incidents/${seg(incidentId)}`),
    /** Open a published incident with its first update. */
    create: async (input: StatusIncidentCreateRequest): Promise<StatusIncidentDetail> =>
      await this.client.request<StatusIncidentDetail>('POST', '/incidents', { body: input }),
    /** Post an update, moving the incident to `status` (a step the lifecycle allows, else `conflict`). */
    update: async (
      incidentId: string,
      input: StatusIncidentUpdateRequest,
    ): Promise<{ incident: StatusIncident; update: StatusIncidentUpdate }> =>
      await this.client.request('POST', `/incidents/${seg(incidentId)}/updates`, { body: input }),
    /** Replace the components the incident affects, and how badly. */
    setComponents: async (incidentId: string, components: StatusAffectedComponent[]): Promise<StatusIncidentDetail> =>
      await this.client.request<StatusIncidentDetail>('PUT', `/incidents/${seg(incidentId)}/components`, {
        body: { components },
      }),
  };

  readonly maintenances = {
    list: async (pageId: string): Promise<StatusMaintenance[]> => {
      const query = new URLSearchParams({ pageId });
      const { maintenances } = await this.client.request<{ maintenances: StatusMaintenance[] }>(
        'GET',
        `/maintenances?${query}`,
      );
      return maintenances;
    },
    /** Schedule a window; Mocco starts and completes it on time. */
    schedule: async (input: StatusMaintenanceInput): Promise<StatusMaintenance> => {
      const body: StatusMaintenanceRequest = {
        ...input,
        scheduledStart: isoOf(input.scheduledStart),
        scheduledEnd: isoOf(input.scheduledEnd),
      };
      return await this.client.request<StatusMaintenance>('POST', '/maintenances', { body });
    },
    /** Cancel a window that hasn't completed; one in progress ends now. */
    cancel: async (maintenanceId: string): Promise<StatusMaintenance> =>
      await this.client.request<StatusMaintenance>('POST', `/maintenances/${seg(maintenanceId)}/cancel`),
  };

  constructor(private readonly client: MoccoClient) {}
}
