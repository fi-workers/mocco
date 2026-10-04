import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ProjectLayout from '@frontend/components/project-layout';
import IncidentDetail from '@frontend/components/status/incident-detail';
import { ProjectSections } from '@frontend/lib/products';

// One status page incident (#148): post updates, its timeline, affected components and postmortem.
export default function ProjectStatusIncidentPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const incidentId = typeof router.query.incidentId === 'string' ? router.query.incidentId : null;

  return (
    <AppShell>
      {id && projectId && incidentId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.status}>
          <IncidentDetail workspaceId={id} projectId={projectId} incidentId={incidentId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
