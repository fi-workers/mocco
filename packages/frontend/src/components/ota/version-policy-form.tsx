import {
  classifyPolicyChange,
  isVersionFloorRaised,
  PolicyDirections,
  versionPolicyRulesSchema,
  versionSchema,
} from '@mocco/common/ota';
import Link from 'next/link';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import {
  describeApprovalPolicy,
  directionLabels,
  parseRules,
  splitVersions,
} from '@frontend/components/ota/policy-text';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { GateRequirements, RoleDto } from '@mocco/common/governance';
import type { PolicyDirection, VersionPolicyOutcome, VersionPolicyRules } from '@mocco/common/ota';

export interface ChangeResult {
  outcome: VersionPolicyOutcome;
  requestId: string | null;
}

interface Props {
  workspaceId: string;
  projectId: string;
  appId: string;
  /** The rules in force, or null when the app has no policy yet. */
  current: VersionPolicyRules | null;
  /** The store link the version check falls back to when the policy sets none. */
  defaultStoreUrl: string | null;
  roles: readonly RoleDto[];
  onResult: (result: ChangeResult) => void;
}

interface RequirementRow {
  /** Client-only identity, so removing a row keeps the others' inputs in place. */
  id: string;
  role: string;
  count: number;
}

const newRow = (role: string, count = 1): RequirementRow => ({ id: crypto.randomUUID(), role, count });

const DEFAULT_MESSAGE = {
  title: 'Update available',
  body: 'A newer version of this app is available. Update from the store to keep using it.',
  action: 'Update',
};
const DEFAULT_INTERVAL_HOURS = 72;

const toneOf: Record<PolicyDirection, (typeof Tones)[keyof typeof Tones]> = {
  [PolicyDirections.tighten]: Tones.warn,
  [PolicyDirections.relax]: Tones.ok,
  [PolicyDirections.none]: Tones.neutral,
};

/** A blank input means "not set". */
function orNull(value: string): string | null {
  // eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** What will happen on submit, in words, given the direction and the policy in force. */
function consequenceOf(direction: PolicyDirection, gate: GateRequirements | null): string {
  if (direction === PolicyDirections.tighten && gate !== null) {
    return `Needs approval (${describeApprovalPolicy(gate)}). It applies once approved.`;
  }
  if (direction === PolicyDirections.relax && gate !== null) {
    return 'Applies at once, and opens a post-hoc review under the approval policy.';
  }
  return 'Applies at once.';
}

/** The first problem with the typed versions, in plain words, or null. */
function versionProblem(fields: Record<string, string | null>, blocked: readonly string[]): string | null {
  const invalid = Object.entries(fields).find(([, value]) => value !== null && !versionSchema.safeParse(value).success);
  if (invalid !== undefined) {
    return `${invalid[0]} must be numbers separated by dots, like 2.3.1.`;
  }
  const badBlocked = blocked.find(version => !versionSchema.safeParse(version).success);
  return badBlocked === undefined ? null : `Blocked version “${badBlocked}” must be like 2.3.1.`;
}

interface FormValues {
  minimum: string;
  recommended: string;
  blockedText: string;
  message: { title: string; body: string; action: string };
  storeUrl: string;
  intervalHours: number;
  approval: { rows: readonly RequirementRow[]; isSelfPrevented: boolean; isReasonRequired: boolean } | null;
}

/** The typed values as a rule set to validate, plus the first version-format problem. */
function buildDraft(current: VersionPolicyRules | null, values: FormValues) {
  const blocked = splitVersions(values.blockedText);
  const minSupportedVersion = orNull(values.minimum);
  const recommendedVersion = orNull(values.recommended);
  const { title, body, action } = values.message;
  const draft = {
    minSupportedVersion,
    recommendedVersion,
    blockedVersions: blocked,
    // Other locales are kept as they are; this form edits the English fallback.
    messages: {
      ...current?.messages,
      en: { title: orNull(title) ?? '', body: orNull(body) ?? '', action: orNull(action) ?? '' },
    },
    storeUrl: orNull(values.storeUrl),
    softPromptIntervalHours: values.intervalHours,
    approvalPolicy:
      values.approval === null
        ? null
        : {
            resume: values.approval.rows.filter(row => row.role !== '').map(({ role, count }) => ({ role, count })),
            prevent_self: values.approval.isSelfPrevented,
            reason_required: values.approval.isReasonRequired,
          },
  };
  const problem = versionProblem(
    { 'Minimum supported': minSupportedVersion, Recommended: recommendedVersion },
    blocked,
  );
  return { draft, problem };
}

function ApprovalPolicyFields({
  workspaceId,
  roles,
  rows,
  onRows,
  isSelfPrevented,
  onSelfPrevented,
  isReasonRequired,
  onReasonRequired,
}: {
  workspaceId: string;
  roles: readonly RoleDto[];
  rows: readonly RequirementRow[];
  onRows: (rows: RequirementRow[]) => void;
  isSelfPrevented: boolean;
  onSelfPrevented: (isOn: boolean) => void;
  isReasonRequired: boolean;
  onReasonRequired: (isOn: boolean) => void;
}) {
  const names = [...new Set([...roles.map(role => role.name), ...rows.map(row => row.role)])];
  if (names.length === 0) {
    return (
      <Notice tone={Tones.neutral} title="No roles yet">
        Approvals are counted per role.{' '}
        <Link href={Routes.workspaceAccess(workspaceId)} className="underline underline-offset-2">
          Create a role on the Access page
        </Link>{' '}
        and add its members first.
      </Notice>
    );
  }
  const update = (index: number, patch: Partial<RequirementRow>) => {
    onRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-end gap-2">
          <label className={labelClass}>
            Role
            <select
              value={row.role}
              onChange={event => {
                update(index, { role: event.target.value });
              }}
              className={inputClass}>
              {names.map(name => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Approvals
            <input
              type="number"
              min={1}
              max={20}
              value={row.count}
              onChange={event => {
                update(index, { count: Math.max(1, Number(event.target.value) || 1) });
              }}
              className={`${inputClass} w-20`}
            />
          </label>
          {rows.length > 1 ? (
            <Button
              variant="ghost"
              className="text-sm"
              aria-label={`Remove approval requirement ${index + 1} (${row.role})`}
              onClick={() => {
                onRows(rows.filter(other => other.id !== row.id));
              }}>
              Remove
            </Button>
          ) : null}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => {
          onRows([...rows, newRow(names[0] ?? '')]);
        }}>
        Add role
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isSelfPrevented}
          onChange={event => {
            onSelfPrevented(event.target.checked);
          }}
        />
        The requester can’t approve their own change
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isReasonRequired}
          onChange={event => {
            onReasonRequired(event.target.checked);
          }}
        />
        Approvers must give a reason
      </label>
    </div>
  );
}

/** The direction preview, problems and the submit button. `direction` is null when there
 * is nothing valid to submit. */
function SubmitBar({
  direction,
  gate,
  issue,
  error,
  isPending,
  isDisabled,
}: {
  direction: PolicyDirection | null;
  gate: GateRequirements | null;
  issue: string | null;
  error: string | null;
  isPending: boolean;
  isDisabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      {direction === null ? null : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone={toneOf[direction]}>{directionLabels[direction]}</StatusBadge>
          <span className="text-muted-foreground">{consequenceOf(direction, gate)}</span>
        </p>
      )}
      {issue === null ? null : <p className="text-sm text-destructive">{issue}</p>}
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" pending={isPending} disabled={isDisabled} className="w-fit text-sm">
        {direction === PolicyDirections.tighten && gate !== null ? 'Request approval' : 'Apply'}
      </Button>
    </div>
  );
}

/**
 * The change form for one store app's version policy. It edits the whole rule set, shows
 * before submitting whether the edit tightens or relaxes (and so whether it waits for
 * approval), asks for the store-live attestation when a version floor is raised, and
 * reports the outcome through `onResult`. Remount it (`key`) when the policy changes.
 */
export default function VersionPolicyForm({
  workspaceId,
  projectId,
  appId,
  current,
  defaultStoreUrl,
  roles,
  onResult,
}: Props) {
  const utils = trpc.useUtils();
  const english = current?.messages.en ?? DEFAULT_MESSAGE;
  const [minimum, setMinimum] = useState(current?.minSupportedVersion ?? '');
  const [recommended, setRecommended] = useState(current?.recommendedVersion ?? '');
  const [blockedText, setBlockedText] = useState(() => (current?.blockedVersions ?? []).join(', '));
  const [title, setTitle] = useState(english.title);
  const [body, setBody] = useState(english.body);
  const [action, setAction] = useState(english.action);
  const [storeUrl, setStoreUrl] = useState(current?.storeUrl ?? '');
  const [intervalHours, setIntervalHours] = useState(current?.softPromptIntervalHours ?? DEFAULT_INTERVAL_HOURS);
  const gate = current?.approvalPolicy ?? null;
  const [isGated, setIsGated] = useState(gate !== null);
  const [rows, setRows] = useState<RequirementRow[]>(
    () => gate?.resume.map(entry => newRow(entry.role, entry.count)) ?? [newRow(roles[0]?.name ?? '')],
  );
  const [isSelfPrevented, setIsSelfPrevented] = useState(gate?.prevent_self ?? true);
  const [isReasonRequired, setIsReasonRequired] = useState(gate?.reason_required ?? false);
  const [isStoreLiveAttested, setIsStoreLiveAttested] = useState(false);
  const [reason, setReason] = useState('');

  const policyChange = trpc.ota.versionPolicy.change.useMutation({
    onSuccess: async result => {
      await Promise.all([
        utils.ota.versionPolicy.get.invalidate({ workspaceId, projectId, appId }),
        utils.ota.versionPolicy.history.invalidate({ workspaceId, projectId, appId }),
        utils.approval.list.invalidate({ workspaceId }),
      ]);
      onResult({ outcome: result.outcome, requestId: result.requestId });
    },
  });

  const { draft, problem } = buildDraft(current, {
    minimum,
    recommended,
    blockedText,
    message: { title, body, action },
    storeUrl,
    intervalHours,
    approval: isGated ? { rows, isSelfPrevented, isReasonRequired } : null,
  });
  const parsed = versionPolicyRulesSchema.safeParse(draft);
  const rules = parsed.success && problem === null ? parsed.data : null;
  const issue = problem ?? (parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Check the fields above.'));
  const direction = rules === null ? null : classifyPolicyChange(current, rules);
  const isFloorRaised = rules !== null && isVersionFloorRaised(current, rules);
  // Both sides go through the schema: stored jsonb comes back with its keys reordered.
  const isUnchanged =
    rules !== null && current !== null && JSON.stringify(rules) === JSON.stringify(parseRules(current));
  const isAttestationMissing = isFloorRaised && !isStoreLiveAttested;

  return (
    <form
      aria-label="Change version policy"
      className="flex flex-col gap-5 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        if (rules === null) {
          return;
        }
        policyChange.mutate({
          workspaceId,
          projectId,
          appId,
          rules,
          storeLiveAttested: isStoreLiveAttested,
          ...(orNull(reason) !== null && { reason: orNull(reason) ?? undefined }),
        });
      }}>
      <div>
        <h3 className="text-sm font-medium">{current === null ? 'Set up force update' : 'Change policy'}</h3>
        <p className="text-xs text-muted-foreground">
          Apps below the minimum must update; below the recommended version they see a prompt they can dismiss.
        </p>
      </div>

      <fieldset className="min-w-0 grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Versions</legend>
        <label className={labelClass}>
          Minimum supported
          <input
            value={minimum}
            placeholder="not set"
            inputMode="decimal"
            onChange={event => {
              setMinimum(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Recommended
          <input
            value={recommended}
            placeholder="not set"
            inputMode="decimal"
            onChange={event => {
              setRecommended(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className={labelClass}>
          Blocked versions
          <input
            value={blockedText}
            placeholder="e.g. 2.1.0, 2.1.1"
            onChange={event => {
              setBlockedText(event.target.value);
            }}
            className={`${inputClass} font-mono`}
          />
        </label>
      </fieldset>

      <fieldset className="min-w-0 flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium">Prompt (English, the fallback for every locale)</legend>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className={labelClass}>
            Title
            <input
              required
              maxLength={120}
              value={title}
              onChange={event => {
                setTitle(event.target.value);
              }}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Button
            <input
              required
              maxLength={40}
              value={action}
              onChange={event => {
                setAction(event.target.value);
              }}
              className={inputClass}
            />
          </label>
        </div>
        <label className={labelClass}>
          Body
          <textarea
            required
            maxLength={1000}
            rows={2}
            value={body}
            onChange={event => {
              setBody(event.target.value);
            }}
            className={`${inputClass} h-auto py-1.5`}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label className={labelClass}>
            Store URL
            <input
              type="url"
              value={storeUrl}
              placeholder={defaultStoreUrl ?? 'https://…'}
              onChange={event => {
                setStoreUrl(event.target.value);
              }}
              className={`${inputClass} font-mono text-xs`}
            />
          </label>
          <label className={labelClass}>
            Prompt again after (hours)
            <input
              type="number"
              min={1}
              max={8760}
              value={intervalHours}
              onChange={event => {
                setIntervalHours(Math.max(1, Math.trunc(Number(event.target.value)) || 1));
              }}
              className={inputClass}
            />
          </label>
        </div>
        {defaultStoreUrl !== null && orNull(storeUrl) === null ? (
          <p className="text-xs text-muted-foreground">
            Left blank, apps open <span className="font-mono">{defaultStoreUrl}</span>.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="min-w-0 flex flex-col gap-3">
        <legend className="mb-2 text-xs font-medium">Approval</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isGated}
            onChange={event => {
              setIsGated(event.target.checked);
              // Roles may have loaded after the form mounted: fill in any blank role.
              setRows(previous =>
                previous.map(row => (row.role === '' ? { ...row, role: roles[0]?.name ?? '' } : row)),
              );
            }}
          />
          Require approval for tightening changes
        </label>
        {isGated ? (
          <ApprovalPolicyFields
            workspaceId={workspaceId}
            roles={roles}
            rows={rows}
            onRows={setRows}
            isSelfPrevented={isSelfPrevented}
            onSelfPrevented={setIsSelfPrevented}
            isReasonRequired={isReasonRequired}
            onReasonRequired={setIsReasonRequired}
          />
        ) : null}
        <p className="text-xs text-muted-foreground">
          Raising a version, blocking one or changing the store link tightens. Lowering or unblocking relaxes: it
          applies at once and is reviewed afterwards. Changing an existing approval policy is approved under the current
          one.
        </p>
      </fieldset>

      {isFloorRaised ? (
        <label className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={isStoreLiveAttested}
            onChange={event => {
              setIsStoreLiveAttested(event.target.checked);
            }}
          />
          <span>
            I confirm the new version is live on the store.{' '}
            <span className="text-muted-foreground">
              Users told to update to a version the store doesn’t have yet are stuck. This confirmation is recorded.
            </span>
          </span>
        </label>
      ) : null}

      <label className={labelClass}>
        Reason (recorded in the history)
        <input
          maxLength={500}
          value={reason}
          placeholder="e.g. 2.3.0 fixes the payment crash"
          onChange={event => {
            setReason(event.target.value);
          }}
          className={inputClass}
        />
      </label>

      <SubmitBar
        direction={isUnchanged ? null : direction}
        gate={gate}
        issue={issue}
        error={errorMessage(policyChange.error)}
        isPending={policyChange.isPending}
        isDisabled={rules === null || isUnchanged || isAttestationMissing}
      />
    </form>
  );
}
