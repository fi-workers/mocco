// A heartbeat monitor's ping URL (#153): shown once, right after the monitor is created or its
// token is replaced, with the commands a cron job runs to ping it. Mocco keeps only the token's
// hash, so the URL can't be shown again; replacing it issues a new one and the old stops working.
import { useState } from 'react';

import { CopyField, errorMessage, Notice, Snippet, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

/** The app's public `/v1` surface, on the ext app at the console's own origin. */
const v1BaseUrl = (): string => `${document.location.origin}/api/ext/v1`;

/** The URL a job pings. */
export const pingUrlOf = (token: string): string => `${v1BaseUrl()}/ping/${token}`;

/** A span of seconds in the largest whole unit: "90 s", "5 min", "1 h 30 min", "2 days". */
export function formatSpan(seconds: number): string {
  if (seconds < 120 && seconds % 60 !== 0) {
    return `${String(seconds)} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min`;
  }
  if (minutes < 48 * 60) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(minutes / 60)} h` : `${String(Math.floor(minutes / 60))} h ${String(rest)} min`;
  }
  return `${String(Math.round(minutes / 1440))} days`;
}

/** A run's duration: milliseconds under a second, then seconds, then minutes and seconds. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${String(ms)} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

/** The ping URL, once, and the commands that ping it. */
export function HeartbeatPingOnce({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const url = pingUrlOf(token);
  const curl = 'curl -fsS -m 10 --retry 3';
  return (
    <section aria-label={`Ping URL for ${name}`} className="flex max-w-2xl flex-col gap-3">
      <Notice tone={Tones.warn} title={`Copy the ping URL for ${name} now`}>
        The token in it is the only credential, and Mocco keeps only its hash, so this is the only time it is shown.
        Replace it from the monitor&apos;s page if it leaks.
      </Notice>
      <CopyField label="Ping URL" value={url} />
      <Snippet label="When the job finishes" value={`${curl} ${url}`} />
      <Snippet label="In a crontab line" value={`0 3 * * * /usr/local/bin/backup.sh && ${curl} ${url}`} />
      <Snippet
        label="With the run time and the exit code (a non-zero code is down at once)"
        value={`${curl} ${url}/start\n/usr/local/bin/backup.sh\n${curl} ${url}/$?`}
      />
      <Snippet
        label="From Node (@mocco/node)"
        value={`import { heartbeat } from '@mocco/node';\n\nawait heartbeat('${token}', { baseUrl: '${v1BaseUrl()}' }).wrap(async () => {\n  await runBackup();\n});`}
      />
      <Button variant="outline" className="w-fit text-sm" onClick={onDone}>
        Done
      </Button>
    </section>
  );
}

/** Replace a heartbeat's ping URL after a confirmation, then show the new one once. */
export function ReplacePingUrl({
  workspaceId,
  projectId,
  monitorId,
  name,
}: {
  workspaceId: string;
  projectId: string;
  monitorId: string;
  name: string;
}) {
  const utils = trpc.useUtils();
  const [isConfirming, setIsConfirming] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const rotate = trpc.status.rotateHeartbeatToken.useMutation({
    onSuccess: async result => {
      setIsConfirming(false);
      setToken(result.token);
      await utils.status.monitor.invalidate({ workspaceId, projectId, monitorId });
    },
  });
  if (token !== null) {
    return (
      <HeartbeatPingOnce
        name={name}
        token={token}
        onDone={() => {
          setToken(null);
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {isConfirming ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            The current URL stops working at once; update the job with the new one.
          </span>
          <Button
            variant="outline"
            size="sm"
            pending={rotate.isPending}
            onClick={() => {
              rotate.mutate({ workspaceId, projectId, monitorId });
            }}>
            Issue a new ping URL
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setIsConfirming(false);
            }}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => {
            setIsConfirming(true);
          }}>
          Replace ping URL
        </Button>
      )}
      {rotate.error ? <p className="text-sm text-destructive">{errorMessage(rotate.error)}</p> : null}
    </div>
  );
}
