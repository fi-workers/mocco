import { McpScopes } from '@mocco/common/mcp';
import { useQuery } from '@tanstack/react-query';
import Image from 'next/image';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import { answerConsent, getAuthorizingApp, useSession } from '@frontend/lib/auth-client';

// What each scope lets the app do, in the words someone deciding should read. A scope not
// listed here is shown by name rather than hidden: an unexplained permission is still one
// the person is granting.
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: 'Know who you are',
  profile: 'See your name',
  email: 'See your email address',
  offline_access: 'Stay signed in without asking you again',
  [McpScopes.approvalsWrite]: 'Approve or reject changes as you, in workspaces that allow agents to decide',
};

const scopesOf = (scope: unknown): string[] =>
  // eslint-disable-next-line sonarjs/null-dereference -- a string's split() never yields null
  typeof scope === 'string' ? scope.split(' ').filter(each => each !== '') : [];

// The consent screen of the authorization server (`provider.ts` CONSENT_PAGE): an app —
// usually an MCP client such as Claude Code or Cursor — asks to act as the signed-in
// person. The server put a signed copy of its request in the query string; the auth
// client sends it back with the answer, so nothing here can widen what was asked for.
export default function ConsentPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const clientId = typeof router.query.client_id === 'string' ? router.query.client_id : undefined;
  const scopes = scopesOf(router.query.scope);
  const [answer, setAnswer] = useState<'allow' | 'deny'>();
  const [error, setError] = useState<string>();

  const { data: app } = useQuery({
    queryKey: ['authorizing-app', clientId],
    queryFn: async () => (clientId === undefined ? null : await getAuthorizingApp(clientId)),
    enabled: clientId !== undefined && session !== null && session !== undefined,
  });
  const appName = app?.client_name ?? clientId ?? 'An app';

  const respond = async (isAccepted: boolean) => {
    setAnswer(isAccepted ? 'allow' : 'deny');
    setError(undefined);
    const { error: failure } = await answerConsent(isAccepted);
    // On success the server's redirect is already being followed; only a failure stays.
    if (failure) {
      setAnswer(undefined);
      setError(failure.message ?? 'Something went wrong. Start again from the app.');
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Image src="/favicon/favicon.svg" alt="Mocco" width={44} height={44} className="rounded-xl" />
        <h1 className="text-xl font-semibold tracking-tight">{appName} wants to use Mocco as you</h1>
        {session ? <p className="text-sm text-muted-foreground">Signed in as {session.user.email}</p> : null}
      </div>

      <section className="flex w-full max-w-sm flex-col gap-3 rounded-xl border p-4">
        <h2 className="text-sm font-medium">It will be able to</h2>
        <ul className="flex flex-col gap-1.5 text-sm">
          {scopes.map(scope => (
            <li key={scope}>{SCOPE_DESCRIPTIONS[scope] ?? scope}</li>
          ))}
          <li>Read what your roles let you read in your workspaces</li>
        </ul>
        <p className="text-xs text-muted-foreground">
          It acts as you and never more: anything your roles do not allow, it cannot do either. Only allow an app you
          just started connecting yourself.
        </p>
      </section>

      <div className="flex w-full max-w-sm flex-col gap-2">
        <Button
          className="h-11 w-full text-sm"
          disabled={answer !== undefined}
          pending={answer === 'allow'}
          onClick={async () => {
            await respond(true);
          }}>
          Allow
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full text-sm"
          disabled={answer !== undefined}
          pending={answer === 'deny'}
          onClick={async () => {
            await respond(false);
          }}>
          Deny
        </Button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </main>
  );
}
