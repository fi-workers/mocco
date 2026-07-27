import { PipelineItemKinds } from '@mocco/common/mocco-config';

import type { GateItem, MoccoConfig, Step, StepItem } from '@mocco/common/mocco-config';

/** The `with` map for a step, if present — an adapter-specific key/value list (ADR 0004: opaque to the core). */
function StepWith({ entries }: { entries: [string, unknown][] }) {
  return (
    <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <dt className="font-medium">{key}</dt>
          <dd className="min-w-0 truncate">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One step row — its `run` label, `executor`, and any `with` options. */
function StepRow({ step }: { step: Step | StepItem }) {
  const withEntries = step.with ? Object.entries(step.with) : [];
  return (
    <li className="rounded-xl border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{step.run}</span>
        <code className="shrink-0 text-xs text-muted-foreground">{step.executor}</code>
      </div>
      {withEntries.length > 0 ? <StepWith entries={withEntries} /> : null}
    </li>
  );
}

/** One gate row (v2) — its name and the roles/counts required to resume it. */
function GateRow({ gate }: { gate: GateItem }) {
  return (
    <li className="rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">Gate: {gate.name}</span>
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">approval</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Requires {gate.resume.map(requirement => `${requirement.count}× ${requirement.role}`).join(', ')}
        {gate.prevent_self ? ' · no self-approval' : ''}
        {gate.reason_required ? ' · reason required' : ''}
      </p>
    </li>
  );
}

/** Renders a parsed `.mocco.yml`: the pipeline name and its ordered items. v1 is a
 * flat step list; v2 mixes steps and gates (rendered by `kind`). Pure presentational
 * — no fetching, no client-side re-parsing (the server already validated this). */
export function PipelineSteps({ config }: { config: MoccoConfig }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Pipeline: {config.pipeline}</h2>
      <ol className="flex flex-col gap-2">
        {config.version === 1
          ? config.steps.map(step => <StepRow key={step.run} step={step} />)
          : config.steps.map(item =>
              item.kind === PipelineItemKinds.gate ? (
                <GateRow key={`gate:${item.name}`} gate={item} />
              ) : (
                <StepRow key={`step:${item.run}`} step={item} />
              ),
            )}
      </ol>
    </section>
  );
}
