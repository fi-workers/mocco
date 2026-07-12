import AppShell from '../components/app-shell';

import type { ShellProps } from '../lib/with-shell';

// User account settings (reached from the sidebar). A shell page — needs a
// workspace like the rest of the app.
export { shellServerSideProps as getServerSideProps } from '../lib/with-shell';

export default function AccountPage({ user, workspaces, activeId }: ShellProps) {
  return (
    <AppShell user={user} workspaces={workspaces} activeId={activeId}>
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-bold tracking-tight">Account</h1>
        <div className="flex items-center gap-4 rounded-xl border border-neutral-200 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 font-semibold text-white">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{user.name}</div>
            <div className="truncate text-sm text-neutral-500">{user.email}</div>
          </div>
        </div>
        <p className="text-sm text-neutral-500">Profile and password editing land here later.</p>
      </div>
    </AppShell>
  );
}
