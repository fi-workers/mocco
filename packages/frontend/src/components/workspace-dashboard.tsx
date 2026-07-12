import { Button } from '@/components/ui/button';

interface Props {
  name: string;
}

// The workspace dashboard: its repositories and the deploys mocco gates for
// them. Repos arrive with the GitHub App (a later slice), so for now this is an
// empty state pointing at connecting GitHub.
export default function WorkspaceDashboard({ name }: Props) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
        <p className="text-sm text-muted-foreground">
          Repositories in this workspace and the deploys mocco gates for them.
        </p>
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
