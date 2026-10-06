import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import TranslationsDashboard from '@frontend/components/help/translations-dashboard';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A help center's translations across every article and language (#213).
export default function ProjectHelpTranslationsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.help}>
          <TranslationsDashboard workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
