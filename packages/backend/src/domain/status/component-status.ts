import { COMPONENT_STATUS_RANK, ComponentStatuses } from '@mocco/common/status';

import type { ComponentImpact, ComponentStatus } from '@mocco/common/status';

/**
 * The status a component shows: the worst of the status an operator set, the impacts of the
 * unresolved incidents affecting it, and `maintenance` while a window covering it is in
 * progress. An incident outranks maintenance, so an outage during a window still shows.
 */
export function deriveComponentStatus(input: {
  manual: ComponentStatus;
  impacts: readonly ComponentImpact[];
  inMaintenance: boolean;
}): ComponentStatus {
  const candidates: ComponentStatus[] = [
    input.manual,
    ...input.impacts,
    input.inMaintenance ? ComponentStatuses.maintenance : ComponentStatuses.operational,
  ];
  return candidates.reduce<ComponentStatus>(
    (worst, status) => (COMPONENT_STATUS_RANK[status] > COMPONENT_STATUS_RANK[worst] ? status : worst),
    ComponentStatuses.operational,
  );
}
