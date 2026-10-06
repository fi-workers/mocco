import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import Glossary from '@frontend/components/help/glossary';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A help center's glossary: terms kept as written and fixed translations (#214).
export default function ProjectHelpGlossaryPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.help}>
          <Glossary workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
