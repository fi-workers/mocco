import type { MoccoConfig } from '@mocco/common/mocco-config';

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

/** Renders a parsed `.mocco.yml`: the pipeline name and its ordered steps
 * (`run`, `executor`, and any `with` options). Pure presentational — no
 * fetching, no client-side re-parsing (the server already validated this). */
export function PipelineSteps({ config }: { config: MoccoConfig }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Pipeline: {config.pipeline}</h2>
      <ol className="flex flex-col gap-2">
        {config.steps.map(step => {
          const withEntries = step.with ? Object.entries(step.with) : [];
          return (
            <li key={step.run} className="rounded-xl border border-border px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">{step.run}</span>
                <code className="shrink-0 text-xs text-muted-foreground">{step.executor}</code>
              </div>
              {withEntries.length > 0 ? <StepWith entries={withEntries} /> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
