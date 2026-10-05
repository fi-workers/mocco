import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ProjectLayout from '@frontend/components/project-layout';
import MonitorDetail from '@frontend/components/status/monitor-detail';
import { ProjectSections } from '@frontend/lib/products';

// One monitor (#150): its state, latest rounds and state changes, its open incident and its settings.
export default function ProjectStatusMonitorPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const monitorId = typeof router.query.monitorId === 'string' ? router.query.monitorId : null;

  return (
    <AppShell>
      {id && projectId && monitorId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.status}>
          <MonitorDetail workspaceId={id} projectId={projectId} monitorId={monitorId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
