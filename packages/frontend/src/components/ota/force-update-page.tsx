import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { OtaApprovalSubjects, VersionPolicyOutcomes } from '@mocco/common/ota';
import { AppPlatforms } from '@mocco/common/project';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { CopyField, Notice, Spinner, Tones } from '@frontend/components/notifications/notification-ui';
import { describeApprovalPolicy, parsePinnedAction, rulesOfPolicy } from '@frontend/components/ota/policy-text';
import VersionPolicyApprovals from '@frontend/components/ota/version-policy-approvals';
import VersionPolicyForm from '@frontend/components/ota/version-policy-form';
import VersionPolicyHistory from '@frontend/components/ota/version-policy-history';
import { useSession } from '@frontend/lib/auth-client';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { ChangeResult } from '@frontend/components/ota/version-policy-form';
import type { ApprovalState } from '@mocco/common/governance';
import type { ProjectAppDto } from '@mocco/common/project';

interface Props {
  workspaceId: string;
  projectId: string;
}

const STORE_PLATFORMS = new Set<string>([AppPlatforms.ios, AppPlatforms.android]);
const platformLabels: Partial<Record<string, string>> = {
  [AppPlatforms.ios]: 'iOS',
  [AppPlatforms.android]: 'Android',
};

/** The store link the version check answers with when the policy sets none (mirrors the server). */
function defaultStoreUrl(app: ProjectAppDto): string | null {
  if (app.platform === AppPlatforms.ios) {
    return app.storeAppId === null ? null : `https://apps.apple.com/app/id${encodeURIComponent(app.storeAppId)}`;
  }
  const androidId = app.storeAppId ?? app.bundleId;
  return androidId === null ? null : `https://play.google.com/store/apps/details?id=${encodeURIComponent(androidId)}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm">{value}</dd>
    </div>
  );
}

function ResultNotice({ result }: { result: ChangeResult }) {
  if (result.outcome === VersionPolicyOutcomes.pendingApproval) {
    return (
      <Notice tone={Tones.neutral} title="Sent for approval">
        The current policy stays in force until the request below is approved.
      </Notice>
    );
  }
  return (
    <Notice tone={Tones.ok} title="Applied">
      Apps pick up the new policy within about a minute.
      {result.requestId === null
        ? null
        : ' A post-hoc review was opened; it stays open below until someone reviews it.'}
    </Notice>
  );
}

/** Force update for one store app: the policy in force, open requests, the change form
 * and the history. Keyed by app, so switching apps starts fresh. */
function AppForceUpdate({ workspaceId, projectId, app }: Props & { app: ProjectAppDto }) {
  const appInput = { workspaceId, projectId, appId: app.id };
  const policyQuery = trpc.ota.versionPolicy.get.useQuery(appInput);
  const historyQuery = trpc.ota.versionPolicy.history.useQuery(appInput);
  const requestsQuery = trpc.approval.list.useQuery({
    workspaceId,
    subjectType: OtaApprovalSubjects.versionPolicy,
    subjectId: app.id,
  });
  const rolesQuery = trpc.role.list.useQuery({ workspaceId });
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const { data: session } = useSession();
  const [result, setResult] = useState<ChangeResult | null>(null);
  // Bumped on every submit so the form starts again from the policy in force (a request
  // that waits for approval leaves the policy unchanged, so the revision alone won't do).
  const [submits, setSubmits] = useState(0);

  if (policyQuery.isPending) {
    return <Spinner />;
  }
  if (policyQuery.isError) {
    return (
      <Notice tone={Tones.danger} title="Couldn’t load the policy">
        {policyQuery.error.message}
      </Notice>
    );
  }
  const { policy } = policyQuery.data;
  const current = policy === null ? null : rulesOfPolicy(policy);
  const requests = requestsQuery.data?.requests ?? [];
  const pending = requests.filter(request => request.state === ApprovalStates.pending);
  const reviewStates = new Map<string, ApprovalState>(
    requests.flatMap(request => {
      const changeId = request.kind === ApprovalKinds.review ? parsePinnedAction(request.action).changeId : null;
      return changeId === null ? [] : [[changeId, request.state] as const];
    }),
  );
  const names = new Map((membersQuery.data?.members ?? []).map(member => [member.userId, member.user.name]));
  const nameOf = (userId: string | null) => (userId === null ? 'Deleted user' : (names.get(userId) ?? 'Former member'));
  // eslint-disable-next-line unicorn/no-unnecessary-global-this -- bare `location` trips no-restricted-globals and `window` trips prefer-global-this (see auth-form.tsx)
  const checkUrl = `${globalThis.location.origin}/api/ext/v1/apps/${app.id}/version-check?version=`;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">In force</h2>
          <span className="text-xs text-muted-foreground">
            {policy === null ? 'No policy yet: every version gets “ok”.' : `Revision ${policy.revision}`}
          </span>
        </div>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Fact label="Minimum supported" value={policy?.minSupportedVersion ?? '—'} />
          <Fact label="Recommended" value={policy?.recommendedVersion ?? '—'} />
          <Fact
            label="Blocked"
            value={policy === null || policy.blockedVersions.length === 0 ? '—' : policy.blockedVersions.join(', ')}
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          Approval: {describeApprovalPolicy(policy?.approvalPolicy ?? null)}
        </p>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            Version check — the app calls this on launch with its installed version (and optionally{' '}
            <span className="font-mono">&amp;locale=</span>):
          </p>
          <CopyField label="Version check URL" value={checkUrl} />
        </div>
      </section>

      {result === null ? null : <ResultNotice result={result} />}

      <VersionPolicyApprovals
        workspaceId={workspaceId}
        projectId={projectId}
        appId={app.id}
        requests={pending}
        current={current}
        changes={historyQuery.data?.changes ?? []}
        nameOf={nameOf}
        myUserId={session?.user.id}
      />

      <VersionPolicyForm
        key={`${policy?.revision ?? 0}-${submits}`}
        workspaceId={workspaceId}
        projectId={projectId}
        appId={app.id}
        current={current}
        defaultStoreUrl={defaultStoreUrl(app)}
        roles={rolesQuery.data?.roles ?? []}
        onResult={next => {
          setResult(next);
          setSubmits(count => count + 1);
        }}
      />

      <VersionPolicyHistory changes={historyQuery.data?.changes} reviewStates={reviewStates} nameOf={nameOf} />
    </div>
  );
}

/**
 * The project's Force update tab. Each iOS or Android app has its own policy: minimum
 * supported, recommended and blocked versions, the prompt, and the approval policy for
 * tightening changes. The selected app is `?app=` in the URL.
 */
export default function ForceUpdatePage({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const appsQuery = trpc.project.listApps.useQuery({ workspaceId, projectId });
  if (appsQuery.isPending) {
    return <Spinner />;
  }
  const storeApps = (appsQuery.data?.apps ?? []).filter(app => STORE_PLATFORMS.has(app.platform));
  if (storeApps.length === 0) {
    return (
      <Notice tone={Tones.neutral} title="No store apps yet">
        Force update works per iOS or Android app.{' '}
        <Link href={Routes.project(workspaceId, projectId)} className="underline underline-offset-2">
          Add your store apps on the project overview
        </Link>
        .
      </Notice>
    );
  }
  const requested = typeof router.query.app === 'string' ? router.query.app : undefined;
  const selected = storeApps.find(app => app.id === requested) ?? storeApps[0];

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Store apps" className="flex flex-wrap gap-2">
        {storeApps.map(app => (
          <Link
            key={app.id}
            href={Routes.projectOta(workspaceId, projectId, app.id)}
            shallow
            aria-current={app.id === selected?.id ? 'page' : undefined}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm transition',
              app.id === selected?.id
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}>
            {app.name} <span className="opacity-70">· {platformLabels[app.platform]}</span>
          </Link>
        ))}
      </nav>
      {selected === undefined ? null : (
        <AppForceUpdate key={selected.id} workspaceId={workspaceId} projectId={projectId} app={selected} />
      )}
    </div>
  );
}
