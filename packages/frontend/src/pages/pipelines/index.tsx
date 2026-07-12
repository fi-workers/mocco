import { getServices } from '@mocco/backend/auth/instance';
import { appRouter } from '@mocco/backend/trpc/root';
import Link from 'next/link';

import { headersFromNode } from '../../lib/node-headers';

import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

// Server-side auth gate + initial data (the Pages Router idiom — no client-side
// redirect). Unauthenticated requests never render the page; authenticated ones
// arrive with their pipelines already loaded.
export const getServerSideProps = (async ({ req }) => {
  const { auth, workspace, pipeline } = getServices();
  const headers = headersFromNode(req.headers);
  const session = await auth.getSession(headers);
  if (!session) return { redirect: { destination: '/', permanent: false } };

  const caller = appRouter.createCaller({ auth, workspace, pipeline, session, headers });
  const list = await caller.pipeline.list();
  return {
    props: {
      pipelines: list.pipelines.map(p => ({ id: p.id, name: p.name })),
    },
  };
}) satisfies GetServerSideProps;

export default function PipelinesPage({ pipelines }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Pipelines</h1>
        <Link href="/pipelines/new" className="text-sm font-medium text-violet-700 hover:text-violet-900">
          + New pipeline
        </Link>
      </div>

      {pipelines.length === 0 ? (
        <p className="text-sm text-neutral-500">No pipelines yet — create one to get started.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pipelines.map(p => (
            <li key={p.id} className="rounded-xl border border-neutral-200 px-4 py-3">
              <Link href={`/pipelines/${p.id}`} className="truncate text-sm font-medium hover:text-violet-700">
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
