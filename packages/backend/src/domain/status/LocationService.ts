// Probe locations (#150, ADR 0027): where `@mocco/probe` agents run. A workspace sees Mocco's
// shared locations (hosted regions, or the embedded probe on a one-box install) and manages
// its own private ones. A private location's token is generated here, returned once, and
// stored only as its SHA-256 hash.
import { AuditActions } from '@mocco/common/audit';
import { LocationKinds } from '@mocco/common/status';

import { LocationCodeTakenError, StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { LocationRow } from '@backend/domain/status/repos/location.repo';
import type { Db } from '@backend/infra/db/types';
import type { LocationInput } from '@mocco/common/status';

export interface LocationDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  now?: () => Date;
}

/** The embedded probe's location. */
export const EMBEDDED_LOCATION = { code: 'embedded', name: 'This server' } as const;

const subject = (locationId: string) => ({ subjectType: 'status_location', subjectId: locationId });

export class LocationService {
  constructor(private readonly deps: LocationDeps) {}

  private get locations() {
    return new LocationRepo(this.deps.db);
  }

  /** The shared locations that are enabled, and every one of the workspace's own. */
  async list(workspaceId: string): Promise<LocationRow[]> {
    return await this.locations.listVisible(workspaceId);
  }

  /** Create a private location; the token is returned only here. */
  async create(
    workspaceId: string,
    actorUserId: string,
    input: LocationInput,
  ): Promise<{ location: LocationRow; token: string }> {
    const token = generateLocationToken();
    let location: LocationRow;
    try {
      location = await this.locations.insert({
        workspaceId,
        code: input.code,
        name: input.name,
        kind: LocationKinds.private,
        tokenHash: hashLocationToken(token),
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === 'mocco_status_locations_workspace_code_uq') {
        throw new LocationCodeTakenError(input.code, { cause: error });
      }
      throw error;
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.statusLocationCreated,
      ...subject(location.id),
      payload: { code: input.code, name: input.name },
    });
    return { location, token };
  }

  /** Replace a private location's token; the old one stops working at once. */
  async rotateToken(
    workspaceId: string,
    actorUserId: string,
    locationId: string,
  ): Promise<{ location: LocationRow; token: string }> {
    const token = generateLocationToken();
    const location = await this.locations.updateOwn(workspaceId, locationId, { tokenHash: hashLocationToken(token) });
    if (location === undefined) {
      throw new StatusEntityNotFoundError('location', locationId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.statusLocationTokenRotated,
      ...subject(locationId),
      payload: { code: location.code },
    });
    return { location, token };
  }

  /**
   * The shared `embedded` location a one-box install's in-process probe runs as (ADR 0027 §6),
   * created on first use. Its token is never handed out: the embedded loop calls ProbeService
   * directly, so nothing authenticates as it over HTTP. Not audited: no person created it.
   */
  async ensureEmbedded(): Promise<LocationRow> {
    return await this.locations.ensureShared({
      code: EMBEDDED_LOCATION.code,
      name: EMBEDDED_LOCATION.name,
      kind: LocationKinds.embedded,
      tokenHash: hashLocationToken(generateLocationToken()),
    });
  }

  /** Stop a private location: it can't lease work and no new monitor can use it. Idempotent. */
  async disable(workspaceId: string, actorUserId: string, locationId: string): Promise<LocationRow> {
    const current = await this.locations.findOwn(workspaceId, locationId);
    if (current === undefined) {
      throw new StatusEntityNotFoundError('location', locationId);
    }
    if (current.disabledAt !== null) {
      return current;
    }
    const location = await this.locations.updateOwn(workspaceId, locationId, {
      disabledAt: this.deps.now?.() ?? new Date(),
    });
    if (location === undefined) {
      throw new StatusEntityNotFoundError('location', locationId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.statusLocationDisabled,
      ...subject(locationId),
      payload: { code: location.code },
    });
    return location;
  }
}
