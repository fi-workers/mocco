import { COMPONENT_STATUS_RANK, ComponentStatuses, MonitorStates } from '@mocco/common/status';

import type { ComponentImpact, ComponentStatus, MonitorState } from '@mocco/common/status';

/**
 * What a linked monitor in `state` puts on a component, or undefined for nothing. An outage
 * runs from `down` to the next `up`, so `recovering` still shows the link's `impactWhenDown`;
 * `degraded` shows degraded. `suspect` is an unconfirmed failure and shows nothing.
 */
export function monitorImpact(state: MonitorState, impactWhenDown: ComponentImpact): ComponentImpact | undefined {
  if (state === MonitorStates.down || state === MonitorStates.recovering) {
    return impactWhenDown;
  }
  return state === MonitorStates.degraded ? ComponentStatuses.degraded : undefined;
}

/**
 * The status a component shows: the worst of the status an operator set, the impacts of the
 * unresolved incidents affecting it, what its linked monitors put on it, and `maintenance`
 * while a window covering it is in progress. An incident or a monitor outranks maintenance,
 * so an outage during a window still shows.
 */
export function deriveComponentStatus(input: {
  manual: ComponentStatus;
  impacts: readonly ComponentImpact[];
  inMaintenance: boolean;
  /** The component's monitor links: each monitor's state and the link's impact when down. */
  monitors?: readonly { state: MonitorState; impactWhenDown: ComponentImpact }[];
}): ComponentStatus {
  const fromMonitors = (input.monitors ?? []).flatMap(link => monitorImpact(link.state, link.impactWhenDown) ?? []);
  const candidates: ComponentStatus[] = [
    input.manual,
    ...input.impacts,
    ...fromMonitors,
    input.inMaintenance ? ComponentStatuses.maintenance : ComponentStatuses.operational,
  ];
  return candidates.reduce<ComponentStatus>(
    (worst, status) => (COMPONENT_STATUS_RANK[status] > COMPONENT_STATUS_RANK[worst] ? status : worst),
    ComponentStatuses.operational,
  );
}
