interface Step {
  run: string;
  executor: string;
  with?: Record<string, unknown>;
}

interface Props {
  steps: Step[];
}

// Presentational — steps only, no gate rendering (v1 has no gates).
export default function PipelineSteps({ steps }: Props) {
  if (steps.length === 0) {
    return <p className="text-sm text-neutral-500">This pipeline has no steps.</p>;
  }

  return (
    <ol className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const withKeys = step.with ? Object.keys(step.with) : [];
        return (
          // `run` names are unique within a pipeline (schema rejects duplicates).
          <li key={step.run} className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-sm font-semibold text-white">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{step.run}</div>
              <div className="truncate text-xs text-neutral-500">
                {step.executor}
                {withKeys.length > 0 && ` · with: ${withKeys.join(', ')}`}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
