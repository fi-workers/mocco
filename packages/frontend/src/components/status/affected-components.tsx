// Pick the components an incident affects and how badly (#148), or what a monitor puts on its
// components while it is down (#150): one row per component of the page, "Not affected" or an impact.
import { componentImpactSchema, ComponentImpacts } from '@mocco/common/status';

import { inputClass } from '@frontend/components/notifications/notification-ui';
import { componentImpactLabels } from '@frontend/components/status/status-ui';

import type { StatusOutputs } from '@frontend/components/status/status-ui';
import type { AffectedComponent } from '@mocco/common/status';

type Component = StatusOutputs['page']['components'][number];

const NOT_AFFECTED = '';

export default function AffectedComponentsPicker({
  components,
  value,
  onChange,
  legend = 'Affected components',
}: {
  components: readonly Component[];
  value: readonly AffectedComponent[];
  onChange: (next: AffectedComponent[]) => void;
  legend?: string;
}) {
  if (components.length === 0) {
    return <p className="text-sm text-muted-foreground">This page has no components yet.</p>;
  }
  const impactOf = (componentId: string) => value.find(entry => entry.componentId === componentId)?.impact;
  const change = (componentId: string, raw: string) => {
    const others = value.filter(entry => entry.componentId !== componentId);
    const parsed = componentImpactSchema.safeParse(raw);
    onChange(parsed.success ? [...others, { componentId, impact: parsed.data }] : others);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{legend}</legend>
      <ul className="flex flex-col gap-1.5">
        {components.map(component => (
          <li key={component.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{component.name}</span>
            <select
              aria-label={`Impact on ${component.name}`}
              className={inputClass}
              value={impactOf(component.id) ?? NOT_AFFECTED}
              onChange={event => {
                change(component.id, event.target.value);
              }}>
              <option value={NOT_AFFECTED}>Not affected</option>
              {Object.values(ComponentImpacts).map(impact => (
                <option key={impact} value={impact}>
                  {componentImpactLabels[impact]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
