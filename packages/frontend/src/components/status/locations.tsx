// The workspace's probe locations (#150), the status section's locations view: Mocco's shared
// locations and the workspace's private ones, with when each last polled and its agent version.
// Owners and admins create a private location, rotate its token and disable it; a token is
// shown once, with the commands that run the probe with it. Members read the list.
import { LOCATION_CODE_PATTERN, LocationKinds } from '@mocco/common/status';
import { useState } from 'react';

import {
  Ago,
  CopyButton,
  CopyField,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { slugFromTitle } from '@frontend/components/status/status-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';

import type { LocationDto, LocationKind } from '@mocco/common/status';

interface Props {
  workspaceId: string;
}

/** A token just issued, with the location it belongs to and the origin the probe calls. */
interface IssuedToken {
  location: LocationDto;
  token: string;
  origin: string;
}

const kindLabels: Readonly<Record<LocationKind, string>> = {
  [LocationKinds.hosted]: 'Hosted',
  [LocationKinds.private]: 'Private',
  [LocationKinds.embedded]: 'This server',
};

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

/** A code suggested from the name: its slug cut to 32 characters, without a trailing hyphen. */
function codeFromName(name: string): string {
  const code = slugFromTitle(name).slice(0, 32);
  // eslint-disable-next-line sonarjs/null-dereference -- code is a string, never null
  return code.endsWith('-') ? code.slice(0, -1) : code;
}

const CODE_HINT = 'Lowercase letters, digits and inner hyphens, up to 32 characters. Unique in the workspace.';

function Snippet({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs">
          {value}
        </pre>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

/** The token, once, and the commands that run a probe with it. */
function TokenOnce({ issued, onDone }: { issued: IssuedToken; onDone: () => void }) {
  const env = `MOCCO_URL=${issued.origin} MOCCO_PROBE_TOKEN=${issued.token}`;
  return (
    <section aria-label={`Token for ${issued.location.name}`} className="flex flex-col gap-3">
      <Notice tone={Tones.warn} title={`Copy the token for ${issued.location.name} now`}>
        Mocco keeps only its hash, so this is the only time it is shown. Run the probe on a machine that can reach the
        services you check and make outbound HTTPS calls to Mocco.
      </Notice>
      <CopyField label="Location token" value={issued.token} />
      <Snippet
        label="Docker"
        value={`docker run -d --restart unless-stopped -e MOCCO_URL=${issued.origin} -e MOCCO_PROBE_TOKEN=${issued.token} ghcr.io/fi-workers/mocco-probe`}
      />
      <Snippet label="Node 22" value={`${env} npx @mocco/probe`} />
      <p className="max-w-prose text-xs text-muted-foreground">
        Until the package and image are published, run it from a checkout of Mocco:{' '}
        <span className="font-mono">yarn workspace @mocco/probe build</span>, then{' '}
        <span className="font-mono">{env} node packages/probe/dist/cli.js</span>.
      </p>
      <Button variant="outline" className="w-fit text-sm" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}

function CreateLocation({
  workspaceId,
  onCreated,
  onCancel,
}: Props & { onCreated: (issued: IssuedToken) => void; onCancel: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [editedCode, setEditedCode] = useState<string | null>(null);
  const code = editedCode ?? codeFromName(name);
  const create = trpc.status.createLocation.useMutation({
    onSuccess: async ({ location, token }) => {
      await utils.status.locations.invalidate();
      onCreated({ location, token, origin: globalThis.location.origin });
    },
  });

  return (
    <form
      aria-label="New private location"
      className="flex max-w-xl flex-col gap-4 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, name, code });
      }}>
      <h3 className="text-sm font-medium">New private location</h3>
      <label className={labelClass}>
        Name
        <input
          className={inputClass}
          placeholder="Office network"
          value={name}
          maxLength={120}
          onChange={event => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className={labelClass}>
        Code
        <input
          className={`${inputClass} font-mono`}
          placeholder="office"
          value={code}
          maxLength={32}
          aria-invalid={code !== '' && !LOCATION_CODE_PATTERN.test(code)}
          onChange={event => {
            setEditedCode(event.target.value.toLowerCase());
          }}
        />
        <span className="font-normal">{CODE_HINT}</span>
      </label>
      {create.error ? <p className="text-sm text-destructive">{errorMessage(create.error)}</p> : null}
      <span className="flex flex-wrap gap-2">
        <Button
          type="submit"
          className="text-sm"
          pending={create.isPending}
          disabled={isBlank(name) || !LOCATION_CODE_PATTERN.test(code)}>
          Create location
        </Button>
        <Button type="button" variant="ghost" className="text-sm" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** Rotate or disable one of the workspace's own locations, each after a confirmation. */
function LocationActions({
  workspaceId,
  location,
  onRotated,
}: Props & { location: LocationDto; onRotated: (issued: IssuedToken) => void }) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState<'rotate' | 'disable' | null>(null);
  const rotate = trpc.status.rotateLocationToken.useMutation({
    onSuccess: async ({ location: rotated, token }) => {
      setConfirming(null);
      await utils.status.locations.invalidate();
      onRotated({ location: rotated, token, origin: globalThis.location.origin });
    },
  });
  const disable = trpc.status.disableLocation.useMutation({
    onSuccess: async () => {
      setConfirming(null);
      await utils.status.locations.invalidate();
    },
  });
  const input = { workspaceId, locationId: location.id };
  const error = rotate.error ?? disable.error;

  return (
    <div className="flex basis-full flex-col gap-2">
      {confirming === null ? (
        <span className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setConfirming('rotate');
            }}>
            Rotate token
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirming('disable');
            }}>
            Disable
          </Button>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {confirming === 'rotate'
              ? 'The current token stops working at once; restart the probe with the new one.'
              : 'The probe stops getting work and no new monitor can use this location. This can’t be undone.'}
          </span>
          <Button
            variant={confirming === 'rotate' ? 'outline' : 'destructive'}
            size="sm"
            pending={rotate.isPending || disable.isPending}
            onClick={() => {
              if (confirming === 'rotate') {
                rotate.mutate(input);
              } else {
                disable.mutate(input);
              }
            }}>
            {confirming === 'rotate' ? `Issue a new token for ${location.name}` : `Disable ${location.name}`}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirming(null);
            }}>
            Cancel
          </Button>
        </span>
      )}
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </div>
  );
}

export default function Locations({ workspaceId }: Props) {
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const [isCreating, setIsCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const locationsQuery = trpc.status.locations.useQuery({ workspaceId });
  const locations = locationsQuery.data?.locations ?? [];
  const onIssued = (next: IssuedToken) => {
    setIsCreating(false);
    setIssued(next);
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">
          Probe locations run your monitors&apos; checks. A private location is a probe you run in your own network;
          locations belong to the workspace, so every project can use them.
          {isAdmin ? '' : ' You have read-only access; owners and admins manage locations.'}
        </p>
        {isAdmin && !isCreating && issued === null ? (
          <Button
            className="text-sm"
            onClick={() => {
              setIsCreating(true);
            }}>
            New private location
          </Button>
        ) : null}
      </div>
      {isCreating ? (
        <CreateLocation
          workspaceId={workspaceId}
          onCreated={onIssued}
          onCancel={() => {
            setIsCreating(false);
          }}
        />
      ) : null}
      {issued === null ? null : (
        <TokenOnce
          issued={issued}
          onDone={() => {
            setIssued(null);
          }}
        />
      )}
      {locationsQuery.isPending ? <Spinner /> : null}
      {locationsQuery.error ? <p className="text-sm text-destructive">{errorMessage(locationsQuery.error)}</p> : null}
      {!locationsQuery.isPending && locations.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No probe locations yet.
        </p>
      ) : null}
      {locations.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {locations.map(location => (
            <li key={location.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{location.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{location.code}</span>
              </span>
              <span className="text-xs text-muted-foreground">{kindLabels[location.kind]}</span>
              <span className="text-xs text-muted-foreground">
                {location.lastSeenAt === null ? (
                  'Never seen'
                ) : (
                  <>
                    Seen <Ago date={location.lastSeenAt} />
                  </>
                )}
                {location.agentVersion === null ? '' : ` · ${location.agentVersion}`}
              </span>
              {location.disabledAt === null ? null : <StatusBadge tone={Tones.neutral}>Disabled</StatusBadge>}
              {isAdmin && location.workspaceId === workspaceId && location.disabledAt === null ? (
                <LocationActions workspaceId={workspaceId} location={location} onRotated={onIssued} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
