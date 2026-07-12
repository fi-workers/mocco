import { useState } from 'react';

import Button from '../../components/button';
import PipelineSteps from '../../components/pipeline-steps';
import { trpc } from '../../lib/trpc';
import { withAuth } from '../../lib/with-auth';

// Preview only (slice 1): parse a pasted `.mocco.yml` and show the pipeline or
// the parse issues. Nothing is persisted — the config's home is the repo,
// fetched at a run's commit later. Auth-guarded (withAuth) — a session is all it needs.
export const getServerSideProps = withAuth(async () => ({ props: {} }));

type PreviewResult = Awaited<ReturnType<typeof trpc.pipeline.preview.mutate>>;

export default function NewPipelinePage() {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await trpc.pipeline.preview.mutate({ source }));
    } catch (previewError) {
      setError((previewError as Error).message);
    }
    setBusy(false);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-10">
      <h1 className="text-xl font-bold tracking-tight">Preview a .mocco.yml</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <textarea
          aria-label="mocco.yml"
          value={source}
          onChange={e => setSource(e.target.value)}
          rows={12}
          placeholder={'version: 1\npipeline: deploy\nsteps:\n  - run: build\n    executor: generic'}
          className="rounded-lg border border-neutral-200 p-3 font-mono text-sm outline-none focus:border-violet-500"
        />
        <Button type="submit" pending={busy} className="h-10 self-start px-4 text-sm">
          {busy ? 'Parsing…' : 'Preview'}
        </Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result?.ok === true && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-700">{result.config.pipeline}</h2>
          <PipelineSteps steps={result.config.steps} />
        </section>
      )}

      {result?.ok === false && (
        <ul className="flex flex-col gap-1">
          {result.issues.map(issue => (
            <li key={`${issue.path}:${issue.code}`} className="text-sm text-red-600">
              {issue.path || 'root'}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
