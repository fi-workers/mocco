import { Button } from '@/components/ui/button';
import { fireAndForget } from '@/lib/fire-and-forget';
import { trpc } from '@/lib/trpc';

/** Starts a GitHub App install: mints a state on the server, then full-navigates to GitHub. */
export function ConnectGithubButton({ workspaceId }: { workspaceId: string }) {
  const { mutateAsync: startInstall, isPending } = trpc.integration.startInstall.useMutation();

  const connect = async (): Promise<void> => {
    const { installUrl } = await startInstall({ workspaceId });
    // Full navigation off the app to GitHub's install page (not a client push).
    // eslint-disable-next-line unicorn/no-unnecessary-global-this
    globalThis.location.assign(installUrl);
  };

  return (
    <Button
      pending={isPending}
      onClick={() => {
        fireAndForget(connect());
      }}>
      Connect GitHub
    </Button>
  );
}
