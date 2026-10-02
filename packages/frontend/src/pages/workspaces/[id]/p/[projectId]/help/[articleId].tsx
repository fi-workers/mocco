import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ArticleEditor from '@frontend/components/help/article-editor';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// Writing one help center article (#96).
export default function ProjectHelpArticlePage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const articleId = typeof router.query.articleId === 'string' ? router.query.articleId : null;

  return (
    <AppShell>
      {id && projectId && articleId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.help}>
          <ArticleEditor workspaceId={id} projectId={projectId} articleId={articleId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
