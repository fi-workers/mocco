import { BadRequestError, ConflictError, NotFoundError } from '@backend/domain/errors';

import type { IncidentStatus, MaintenanceStatus } from '@mocco/common/status';

/** A status page, group, component, incident or maintenance window the project doesn't have — NOT_FOUND. */
export class StatusEntityNotFoundError extends NotFoundError {
  constructor(
    kind: 'page' | 'group' | 'component' | 'incident' | 'maintenance' | 'monitor' | 'location' | 'run' | 'run link',
    id: string,
    options?: ErrorOptions,
  ) {
    super(`Status ${kind} ${id} was not found`, options);
    this.name = 'StatusEntityNotFoundError';
  }
}

/** Another status page already uses the slug (slugs are global) — CONFLICT. */
export class StatusPageSlugTakenError extends ConflictError {
  constructor(slug: string, options?: ErrorOptions) {
    super(`The status page address "${slug}" is taken`, options);
    this.name = 'StatusPageSlugTakenError';
  }
}

/** The workspace already has a location with the code — CONFLICT. */
export class LocationCodeTakenError extends ConflictError {
  constructor(code: string, options?: ErrorOptions) {
    super(`A location with the code "${code}" already exists`, options);
    this.name = 'LocationCodeTakenError';
  }
}

/** An update asked for a status change the incident lifecycle doesn't allow — CONFLICT. */
export class IncidentTransitionError extends ConflictError {
  constructor(from: IncidentStatus, to: IncidentStatus, options?: ErrorOptions) {
    super(from === to ? `The incident is already ${from}` : `An incident can't go from ${from} to ${to}`, options);
    this.name = 'IncidentTransitionError';
  }
}

/** Canceling a window that already completed or was canceled — CONFLICT. */
export class MaintenanceTransitionError extends ConflictError {
  constructor(status: MaintenanceStatus, options?: ErrorOptions) {
    super(`A ${status} maintenance window can't be canceled`, options);
    this.name = 'MaintenanceTransitionError';
  }
}

/** An ad-hoc check of a paused monitor: it has no rounds until it is resumed — CONFLICT. */
export class MonitorPausedError extends ConflictError {
  constructor(monitorId: string, options?: ErrorOptions) {
    super(`Monitor ${monitorId} is paused; resume it to check it`, options);
    this.name = 'MonitorPausedError';
  }
}

/** A maintenance window that ends before it starts — BAD_REQUEST. */
export class MaintenanceWindowError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super('A maintenance window ends after it starts', options);
    this.name = 'MaintenanceWindowError';
  }
}
