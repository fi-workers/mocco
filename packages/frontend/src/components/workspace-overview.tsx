import { Button } from '@frontend/components/ui/button';

// A workspace's Overview section: its repositories and the deploys mocco gates
// for them. Repos arrive with the GitHub App (a later slice), so for now this is
// an empty state pointing at connecting GitHub.
export default function WorkspaceOverview() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
        <p className="text-sm text-muted-foreground">The repositories in this workspace and the deploys mocco gates.</p>
      </header>

      <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
        <h2 className="text-sm font-medium">No repositories yet</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Connect GitHub to import repositories and start gating their deploys.
        </p>
        <Button variant="secondary" disabled>
          Connect GitHub
        </Button>
      </section>
    </div>
  );
}
