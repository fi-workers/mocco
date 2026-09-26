import { ChannelStatuses } from '@mocco/common/notification';
import Link from 'next/link';
import { useState } from 'react';

import ChannelRules from '@frontend/components/notifications/channel-rules';
import { discordFixHint } from '@frontend/components/notifications/discord-hints';
import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button, buttonVariants } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { InboundSourceDto } from '@mocco/common/inbound';
import type { ChannelTestResult, DiscordGuildDto, NotificationChannelDto } from '@mocco/common/notification';

interface Props {
  workspaceId: string;
  isAdmin: boolean;
}

/** What the test message said, with what to fix when it failed. */
function TestResult({ channelName, test }: { channelName: string; test: ChannelTestResult }) {
  if (test.sent) {
    return (
      <Notice tone={Tones.ok} title={`Test message sent to ${channelName}`}>
        Look for “Mocco is connected” in Discord. Add rules below to choose what this channel receives.
      </Notice>
    );
  }
  const hint = discordFixHint(test.reason);
  return (
    <Notice
      tone={test.channelDisabled ? Tones.danger : Tones.warn}
      title={
        test.channelDisabled
          ? `The test message failed, so ${channelName} was added disabled`
          : `The test message to ${channelName} was not sent`
      }>
      <p className="font-mono text-xs">{test.reason ?? 'no reason given'}</p>
      {hint === undefined ? null : <p className="mt-1">{hint}</p>}
    </Notice>
  );
}

/** Guild → channel picker, optional label, then the test message result. */
function AddChannelForm({
  workspaceId,
  guilds,
  onDone,
}: {
  workspaceId: string;
  guilds: DiscordGuildDto[];
  onDone: (result: { channelName: string; test: ChannelTestResult }) => void;
}) {
  const utils = trpc.useUtils();
  const [guildId, setGuildId] = useState(guilds.length === 1 ? (guilds[0]?.id ?? '') : '');
  const [channelId, setChannelId] = useState('');
  const [label, setLabel] = useState('');
  const channelsQuery = trpc.notification.guildChannels.useQuery(
    { workspaceId, guildId },
    { enabled: guildId !== '', retry: false },
  );
  const create = trpc.notification.createChannel.useMutation({
    onSuccess: ({ channel, test }) => {
      onDone({ channelName: channel.name, test });
      fireAndForget(utils.notification.channels.invalidate({ workspaceId }));
    },
  });
  const discordChannels = channelsQuery.data?.channels ?? [];

  return (
    <form
      aria-label="Add a channel"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        // eslint-disable-next-line sonarjs/null-dereference -- label is a useState<string>, never null
        const trimmed = label.trim();
        create.mutate({ workspaceId, guildId, channelId, ...(trimmed !== '' && { name: trimmed }) });
      }}>
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          Server
          <select
            className={cn(inputClass, 'w-52')}
            value={guildId}
            onChange={event => {
              setGuildId(event.target.value);
              setChannelId('');
            }}>
            <option value="">Select a server…</option>
            {guilds.map(guild => (
              <option key={guild.id} value={guild.id}>
                {guild.guildName}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Channel
          <select
            className={cn(inputClass, 'w-52')}
            value={channelId}
            disabled={guildId === '' || channelsQuery.isPending}
            onChange={event => {
              setChannelId(event.target.value);
            }}>
            <option value="">
              {guildId !== '' && channelsQuery.isFetching ? 'Loading channels…' : 'Select a channel…'}
            </option>
            {discordChannels.map(channel => (
              <option key={channel.id} value={channel.id}>
                #{channel.name}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Label (optional)
          <input
            className={cn(inputClass, 'w-44')}
            placeholder="#alerts"
            value={label}
            onChange={event => {
              setLabel(event.target.value);
            }}
          />
        </label>
        <Button type="submit" pending={create.isPending} disabled={guildId === '' || channelId === ''}>
          Add channel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The list shows the text and announcement channels the Mocco bot can see. A private channel appears after you
        give the bot access to it. Mocco posts a test message when you add the channel.
      </p>
      {channelsQuery.error === null ? null : (
        <Notice tone={Tones.danger} title="Could not list the server's channels">
          {channelsQuery.error.message}
        </Notice>
      )}
      {create.error === null ? null : (
        <Notice tone={Tones.danger} title="The channel was not added">
          {errorMessage(create.error)}
        </Notice>
      )}
    </form>
  );
}

function ChannelCard({
  workspaceId,
  channel,
  guildName,
  isAdmin,
  sources,
}: Props & { channel: NotificationChannelDto; guildName: string | undefined; sources: InboundSourceDto[] }) {
  const utils = trpc.useUtils();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const refresh = () => {
    fireAndForget(utils.notification.channels.invalidate({ workspaceId }));
  };
  const reenable = trpc.notification.reenableChannel.useMutation({ onSuccess: refresh });
  const remove = trpc.notification.deleteChannel.useMutation({ onSuccess: refresh });
  const isDisabled = channel.status === ChannelStatuses.disabled;
  const hint = discordFixHint(channel.disabledReason);

  return (
    <li className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{channel.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            Discord · {guildName ?? 'server'} · #{channel.config.channelName}
          </p>
        </div>
        {isDisabled ? (
          <StatusBadge tone={Tones.danger}>Disabled</StatusBadge>
        ) : (
          <StatusBadge tone={Tones.ok}>Active</StatusBadge>
        )}
        {isAdmin ? (
          <div className="flex items-center gap-1.5">
            {isDisabled ? (
              <Button
                size="sm"
                pending={reenable.isPending}
                onClick={() => {
                  reenable.mutate({ workspaceId, channelId: channel.id });
                }}>
                Re-enable
              </Button>
            ) : null}
            {confirmingDelete ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  pending={remove.isPending}
                  onClick={() => {
                    remove.mutate({ workspaceId, channelId: channel.id });
                  }}>
                  Confirm delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmingDelete(false);
                  }}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirmingDelete(true);
                }}>
                Delete
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {isDisabled ? (
        <Notice tone={Tones.danger} title="Mocco stopped posting to this channel">
          <p className="font-mono text-xs">{channel.disabledReason ?? 'no reason recorded'}</p>
          <p className="mt-1">
            {hint ?? 'Fix the bot’s access in Discord, then re-enable the channel.'}{' '}
            <Link href={`${Routes.notificationsGuide('troubleshooting')}#disabled-channels`} className="underline">
              Troubleshooting
            </Link>
          </p>
        </Notice>
      ) : null}
      {reenable.data === undefined ? null : (
        <TestResult channelName={reenable.data.channel.name} test={reenable.data.test} />
      )}
      {reenable.error === null ? null : (
        <Notice tone={Tones.danger} title="The channel was not re-enabled">
          {reenable.error.message}
        </Notice>
      )}

      <ChannelRules workspaceId={workspaceId} channelId={channel.id} canEdit={isAdmin} sources={sources} />
    </li>
  );
}

function ConnectDiscord({ workspaceId, isAdmin, hasGuilds }: Props & { hasGuilds: boolean }) {
  const setupQuery = trpc.notification.discordSetup.useQuery({ workspaceId });
  if (setupQuery.data === undefined) {
    return null;
  }
  if (!setupQuery.data.installAvailable) {
    return (
      <Notice tone={Tones.warn} title="Discord is not set up on this Mocco server">
        The Mocco bot has no Discord credentials here, so no server can be connected yet. Whoever runs this Mocco server
        needs to configure the Discord bot first.
      </Notice>
    );
  }
  if (!isAdmin) {
    return hasGuilds ? null : (
      <p className="text-sm text-muted-foreground">Only an owner or admin can connect Discord.</p>
    );
  }
  return (
    <a
      href={Routes.discordInstall(workspaceId)}
      className={cn(buttonVariants({ variant: hasGuilds ? 'outline' : 'default' }))}>
      {hasGuilds ? 'Connect another server' : 'Connect Discord'}
    </a>
  );
}

/**
 * The Channels tab: connect Discord (the bot install), the connected servers, the
 * channels Mocco posts to (status, disabled reason, re-enable) and each channel's rules.
 */
export default function NotificationChannels({ workspaceId, isAdmin }: Props) {
  const guildsQuery = trpc.notification.guilds.useQuery({ workspaceId });
  const channelsQuery = trpc.notification.channels.useQuery({ workspaceId });
  // Sources name the "only from source" of a rule; a server without inbound has none.
  const sourcesQuery = trpc.inbound.sources.list.useQuery({ workspaceId }, { retry: false });
  const [adding, setAdding] = useState(false);
  const [lastTest, setLastTest] = useState<{ channelName: string; test: ChannelTestResult } | null>(null);

  if (guildsQuery.isPending || channelsQuery.isPending) {
    return <Spinner />;
  }
  if (guildsQuery.isError || channelsQuery.isError) {
    return (
      <Notice tone={Tones.danger} title="Notifications could not be loaded">
        {guildsQuery.error?.message ?? channelsQuery.error?.message}
      </Notice>
    );
  }

  const { guilds } = guildsQuery.data;
  const { channels } = channelsQuery.data;
  const sources = sourcesQuery.data?.sources ?? [];
  const guildNames = new Map(guilds.map(guild => [guild.guildId, guild.guildName]));

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="discord-servers" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="discord-servers" className="text-base font-semibold">
              Discord servers
            </h2>
            <p className="text-sm text-muted-foreground">
              Servers the Mocco bot was added to for this workspace.{' '}
              <Link href={Routes.notificationsGuide('connect-discord')} className="underline underline-offset-2">
                How to connect Discord
              </Link>
            </p>
          </div>
          <ConnectDiscord workspaceId={workspaceId} isAdmin={isAdmin} hasGuilds={guilds.length > 0} />
        </div>
        {guilds.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No Discord server connected yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {guilds.map(guild => (
              <li key={guild.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="flex size-6 items-center justify-center rounded-md bg-[#5865F2] text-[11px] font-semibold text-white">
                  {guild.guildName.charAt(0).toUpperCase()}
                </span>
                <span className="font-medium">{guild.guildName}</span>
                <span className="text-xs text-muted-foreground">
                  connected <Ago date={guild.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="notification-channels" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="notification-channels" className="text-base font-semibold">
              Channels
            </h2>
            <p className="text-sm text-muted-foreground">Where Mocco posts, and which events each channel gets.</p>
          </div>
          {isAdmin && guilds.length > 0 ? (
            <Button
              variant={adding ? 'ghost' : 'default'}
              onClick={() => {
                setAdding(value => !value);
              }}>
              {adding ? 'Close' : 'Add channel'}
            </Button>
          ) : null}
        </div>
        {adding ? (
          <AddChannelForm
            workspaceId={workspaceId}
            guilds={guilds}
            onDone={result => {
              setLastTest(result);
              setAdding(false);
            }}
          />
        ) : null}
        {lastTest === null ? null : <TestResult channelName={lastTest.channelName} test={lastTest.test} />}
        {channels.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {guilds.length === 0 ? 'Connect Discord to add a channel.' : 'No channels yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {channels.map(channel => (
              <ChannelCard
                key={channel.id}
                workspaceId={workspaceId}
                channel={channel}
                guildName={guildNames.get(channel.config.guildId)}
                isAdmin={isAdmin}
                sources={sources}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
