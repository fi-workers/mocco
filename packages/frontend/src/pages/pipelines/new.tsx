import { getServices } from '@mocco/backend/auth/instance';

import PipelineYamlForm from '../../components/pipeline-yaml-form';
import { headersFromNode } from '../../lib/node-headers';

import type { GetServerSideProps } from 'next';

// Server-side auth gate only — no data to preload.
export const getServerSideProps = (async ({ req }) => {
  const { auth } = getServices();
  const headers = headersFromNode(req.headers);
  const session = await auth.getSession(headers);
  if (!session) return { redirect: { destination: '/', permanent: false } };

  return { props: {} };
}) satisfies GetServerSideProps;

export default function NewPipelinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <h1 className="text-xl font-bold tracking-tight">New pipeline</h1>
      <PipelineYamlForm />
    </main>
  );
}
