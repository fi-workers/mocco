import { useRouter } from 'next/router';
import { useState } from 'react';

import { trpc } from '../lib/trpc';

export default function PipelineYamlForm() {
  const router = useRouter();
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    // No try/finally: React Compiler can't optimize components containing `finally` clauses.
    try {
      const result = await trpc.pipeline.submit.mutate({ source });
      await router.push(`/pipelines/${result.pipeline.id}`);
    } catch (submitError) {
      // The tRPC BAD_REQUEST message from an invalid .mocco.yml IS the UX.
      setError((submitError as Error).message);
    }
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <textarea
        required
        value={source}
        onChange={e => setSource(e.target.value)}
        placeholder={'version: 1\npipeline: deploy\nsteps:\n  - run: build\n    executor: generic\n'}
        aria-label="mocco.yml"
        rows={16}
        className="rounded-lg border border-neutral-200 px-3 py-2 font-mono text-sm outline-none focus:border-violet-500"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="h-11 rounded-lg bg-violet-600 text-sm font-medium text-white transition hover:bg-violet-700 disabled:opacity-50">
        {submitting ? 'Submitting…' : 'Submit pipeline'}
      </button>
    </form>
  );
}
