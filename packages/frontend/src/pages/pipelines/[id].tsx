import { getServices } from '@mocco/backend/auth/instance';
import { appRouter } from '@mocco/backend/trpc/root';
import { TRPCError } from '@trpc/server';

import PipelineSteps from '../../components/pipeline-steps';
import { headersFromNode } from '../../lib/node-headers';

import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

// Server-side auth gate + initial data (the Pages Router idiom — no client-side
// redirect). Unauthenticated requests never render the page; a missing/foreign
// pipeline id renders Next's built-in 404.
export const getServerSideProps = (async ({ req, params }) => {
  const { auth, workspace, pipeline } = getServices();
  const headers = headersFromNode(req.headers);
  const session = await auth.getSession(headers);
  if (!session) return { redirect: { destination: '/', permanent: false } };

  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  if (!id) return { notFound: true };

  const caller = appRouter.createCaller({ auth, workspace, pipeline, session, headers });
  try {
    const { pipeline: found, version } = await caller.pipeline.get({ id });
    return {
      props: {
        name: found.name,
        steps: version?.definition.steps ?? [],
      },
    };
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return { notFound: true };
    throw error;
  }
}) satisfies GetServerSideProps;

export default function PipelinePage({ name, steps }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <h1 className="text-xl font-bold tracking-tight">{name}</h1>
      <PipelineSteps steps={steps} />
    </main>
  );
}
