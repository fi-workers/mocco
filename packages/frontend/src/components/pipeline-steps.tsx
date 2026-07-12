interface StepView {
  run: string;
  executor: string;
  with?: Record<string, unknown>;
}

/** Presentational — the ordered steps of a parsed pipeline. v1 has steps only
 * (gates arrive in a later slice). */
export default function PipelineSteps({ steps }: { steps: StepView[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, index) => (
        <li key={step.run} className="rounded-xl border border-neutral-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100 text-xs font-medium text-neutral-600">
              {index + 1}
            </span>
            <span className="text-sm font-medium">{step.run}</span>
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
              {step.executor}
            </span>
          </div>
          {step.with && Object.keys(step.with).length > 0 && (
            <div className="mt-1 pl-9 font-mono text-xs text-neutral-500">{Object.keys(step.with).join(', ')}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
