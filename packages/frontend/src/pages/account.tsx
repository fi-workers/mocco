import AppShell from '@/components/app-shell';
import { useSession } from '@/lib/auth-client';

// User account settings. AppShell guards the session; the profile card reads the
// same (cached) session client-side.
export default function AccountPage() {
  const { data: session } = useSession();

  return (
    <AppShell>
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-bold tracking-tight">Account</h1>
        <div className="flex items-center gap-4 rounded-xl border border-border p-5">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
            {(session?.user.name ?? '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{session?.user.name}</div>
            <div className="truncate text-sm text-muted-foreground">{session?.user.email}</div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Profile and password editing land here later.</p>
      </div>
    </AppShell>
  );
}
