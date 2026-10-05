// A status page's gates that announce maintenance (#158): when a run of a repository linked to
// the project resumes a gate with one of these names, a window with its title starts on the page
// for its components, expected to take its minutes, and the run's end completes it. Add one,
// change it (setting the same gate name again replaces it) or remove it.
import { GateMaintenanceLimits } from '@mocco/common/status';
import { useState } from 'react';

import { errorMessage, inputClass, labelClass } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';

interface Props {
  workspaceId: string;
  projectId: string;
  pageId: string;
  components: readonly Component[];
}

type GateMaintenance = StatusOutputs['gateMaintenances']['gateMaintenances'][number];
type Component = StatusOutputs['page']['components'][number];

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

function GateMaintenanceForm({
  workspaceId,
  projectId,
  pageId,
  components,
  editing,
  onDone,
}: Props & { editing: GateMaintenance | undefined; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [gateName, setGateName] = useState(editing?.gateName ?? '');
  const [title, setTitle] = useState(editing?.title ?? '');
  const [minutes, setMinutes] = useState(String(editing?.expectedMinutes ?? 20));
  const [componentIds, setComponentIds] = useState<string[]>(editing?.componentIds ?? []);
  const save = trpc.status.setGateMaintenance.useMutation({
    onSuccess: async () => {
      await utils.status.gateMaintenances.invalidate();
      onDone();
    },
  });
  const expectedMinutes = Number(minutes);
  const isMinutesValid =
    Number.isSafeInteger(expectedMinutes) &&
    expectedMinutes >= 1 &&
    expectedMinutes <= GateMaintenanceLimits.expectedMinutesMax;
  const toggle = (componentId: string, isOn: boolean) => {
    setComponentIds(current => (isOn ? [...current, componentId] : current.filter(id => id !== componentId)));
  };

  return (
    <form
      aria-label={editing === undefined ? 'Add a gate' : `Edit ${editing.gateName}`}
      className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        save.mutate({ workspaceId, projectId, pageId, gateName, title, expectedMinutes, componentIds });
      }}>
      <div className="flex flex-wrap gap-4">
        <label className={labelClass}>
          Gate name
          <input
            className={inputClass}
            placeholder="production"
            value={gateName}
            maxLength={GateMaintenanceLimits.gateNameMax}
            readOnly={editing !== undefined}
            onChange={event => {
              setGateName(event.target.value);
            }}
          />
        </label>
        <label className={labelClass}>
          Expected minutes
          <input
            type="number"
            min={1}
            max={GateMaintenanceLimits.expectedMinutesMax}
            className={`${inputClass} w-28`}
            value={minutes}
            aria-invalid={!isMinutesValid}
            onChange={event => {
              setMinutes(event.target.value);
            }}
          />
        </label>
      </div>
      <label className={labelClass}>
        Window title
        <input
          className={inputClass}
          placeholder="Deploying the API"
          value={title}
          maxLength={120}
          onChange={event => {
            setTitle(event.target.value);
          }}
        />
      </label>
      {components.length === 0 ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Components under maintenance</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {components.map(component => (
              <label key={component.id} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={componentIds.includes(component.id)}
                  onChange={event => {
                    toggle(component.id, event.target.checked);
                  }}
                />
                {component.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="text-sm"
          pending={save.isPending}
          disabled={isBlank(gateName) || isBlank(title) || !isMinutesValid}>
          Save
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function GateMaintenanceRow({
  workspaceId,
  projectId,
  gate,
  components,
  onEdit,
}: Omit<Props, 'pageId'> & { gate: GateMaintenance; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const remove = trpc.status.deleteGateMaintenance.useMutation({
    onSuccess: async () => {
      await utils.status.gateMaintenances.invalidate();
    },
  });
  const names = gate.componentIds.flatMap(id => components.find(component => component.id === id)?.name ?? []);

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-sm">
          <code className="font-medium">{gate.gateName}</code> announces “{gate.title}”
        </span>
        <Button variant="ghost" size="sm" aria-label={`Edit ${gate.gateName}`} onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${gate.gateName}`}
          pending={remove.isPending}
          onClick={() => {
            remove.mutate({ workspaceId, projectId, gateMaintenanceId: gate.id });
          }}>
          Remove
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Expected to take {gate.expectedMinutes} min
        {names.length === 0 ? '' : ` · covers ${names.join(', ')}`}
      </p>
      {remove.error ? <p className="text-sm text-destructive">{errorMessage(remove.error)}</p> : null}
    </li>
  );
}

export default function GateMaintenances({ workspaceId, projectId, pageId, components }: Props) {
  // `new` for the add form, a gate maintenance's id while editing it.
  const [open, setOpen] = useState<string | null>(null);
  const gatesQuery = trpc.status.gateMaintenances.useQuery({ workspaceId, projectId, pageId });
  const gates = gatesQuery.data?.gateMaintenances ?? [];
  const formProps = { workspaceId, projectId, pageId, components, onDone: () => setOpen(null) };

  return (
    <section className="flex flex-col gap-2" aria-labelledby="gate-maintenances">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex max-w-prose flex-col gap-1">
          <h3 id="gate-maintenances" className="text-sm font-medium">
            Gates that announce maintenance
          </h3>
          <p className="text-sm text-muted-foreground">
            When a run of a repository linked to this project resumes a gate with one of these names, a window starts
            here and ends when the run finishes, however it ends. If it is still going after the expected minutes, Mocco
            flags it and sends an alert.
          </p>
        </div>
        {open === null ? (
          <Button
            className="text-sm"
            variant="outline"
            onClick={() => {
              setOpen('new');
            }}>
            Add a gate
          </Button>
        ) : null}
      </div>
      {open === 'new' ? <GateMaintenanceForm {...formProps} editing={undefined} /> : null}
      {gatesQuery.error ? <p className="text-sm text-destructive">{errorMessage(gatesQuery.error)}</p> : null}
      {gates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No gate announces maintenance on this page.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {gates.map(gate =>
            open === gate.id ? (
              <li key={gate.id} className="p-2">
                <GateMaintenanceForm {...formProps} editing={gate} />
              </li>
            ) : (
              <GateMaintenanceRow
                key={gate.id}
                workspaceId={workspaceId}
                projectId={projectId}
                components={components}
                gate={gate}
                onEdit={() => {
                  setOpen(gate.id);
                }}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}
