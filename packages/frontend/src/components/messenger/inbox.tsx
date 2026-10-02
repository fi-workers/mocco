// The project's messenger inbox (#95): set the messenger up (the identity secret is shown
// once), then the open or closed conversations, newest activity first, and the settings
// (categories, rotating the secret).
import { ConversationStatuses } from '@mocco/common/messenger';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  Ago,
  CopyField,
  errorMessage,
  inputClass,
  Notice,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ConversationStatus, MessengerCategory } from '@mocco/common/messenger';

interface Props {
  workspaceId: string;
  projectId: string;
}

/** How often the inbox looks for new messages while open. */
export const INBOX_REFRESH_MS = 15_000;

const SIGNING_SNIPPET = `import { signIdentity } from '@mocco/node';

// On your server, for the signed-in user:
const userHash = signIdentity(process.env.MOCCO_MESSENGER_SECRET, user.id);`;

/** The secret, shown once, with how to use it. */
function SecretNotice({ secret, title }: { secret: string; title: string }) {
  return (
    <Notice tone={Tones.warn} title={title}>
      <div className="flex flex-col gap-2">
        <p>
          Your server signs each user id with this secret, so your app can only speak for users you signed in. It is
          shown only now; store it as a server secret.
        </p>
        <CopyField label="Identity secret" value={secret} />
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{SIGNING_SNIPPET}</pre>
      </div>
    </Notice>
  );
}

/** A category key from its label: `Account deletion` → `account-deletion`. */
function keyOf(label: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- label is a string, never null
  const key = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
    .slice(0, 40);
  return key === '' ? 'category' : key;
}

function Setup({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const enable = trpc.messenger.enable.useMutation();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Set up the messenger</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Your signed-in users write to you from your app, and you answer here. Mocco creates an identity secret: your
          server signs each user id with it, and your app sends the signature with the user id, so no one can write as
          someone else.
        </p>
      </div>
      {enable.data ? (
        <>
          <SecretNotice secret={enable.data.identitySecret} title="Messenger is set up" />
          <p className="text-sm text-muted-foreground">
            Next, create a publishable key with <span className="font-mono">messenger:chat</span> on the{' '}
            <Link href={Routes.projectApiKeys(workspaceId, projectId)} className="underline underline-offset-2">
              API keys
            </Link>{' '}
            tab for your app.
          </p>
          <Button
            variant="outline"
            className="w-fit text-sm"
            onClick={async () => {
              await utils.messenger.settings.invalidate();
            }}>
            Open the inbox
          </Button>
        </>
      ) : (
        <Button
          className="w-fit text-sm"
          pending={enable.isPending}
          onClick={() => {
            enable.mutate({ workspaceId, projectId });
          }}>
          Set up messenger
        </Button>
      )}
      {enable.error ? <p className="text-sm text-destructive">{errorMessage(enable.error)}</p> : null}
    </section>
  );
}

function Conversations({ workspaceId, projectId, categories }: Props & { categories: readonly MessengerCategory[] }) {
  const router = useRouter();
  const status: ConversationStatus = router.query.status === 'closed' ? 'closed' : 'open';
  const inboxQuery = trpc.messenger.inbox.useQuery(
    { workspaceId, projectId, status },
    { refetchInterval: INBOX_REFRESH_MS },
  );
  const conversations = inboxQuery.data?.conversations ?? [];
  const labelOf = (key: string | null) =>
    key === null ? null : (categories.find(category => category.key === key)?.label ?? key);

  return (
    <section className="flex flex-col gap-3">
      <nav aria-label="Conversation status" className="flex gap-1 border-b border-border">
        {Object.values(ConversationStatuses).map(value => (
          <Link
            key={value}
            href={Routes.projectInbox(workspaceId, projectId, value)}
            aria-current={value === status ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              value === status ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground'
            }`}>
            {value === 'open' ? 'Open' : 'Closed'}
          </Link>
        ))}
      </nav>
      {inboxQuery.isPending ? <Spinner /> : null}
      {inboxQuery.error ? <p className="text-sm text-destructive">{errorMessage(inboxQuery.error)}</p> : null}
      {!inboxQuery.isPending && conversations.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {status === 'open' ? 'No open conversations.' : 'No closed conversations yet.'}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {conversations.map(conversation => (
          <li key={conversation.id}>
            <Link
              href={Routes.projectConversation(workspaceId, projectId, conversation.id)}
              className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40">
              <span
                aria-label={conversation.isUnread ? 'Unread' : undefined}
                className={`mt-1.5 size-2 shrink-0 rounded-full ${conversation.isUnread ? 'bg-primary' : 'bg-transparent'}`}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`text-sm ${conversation.isUnread ? 'font-semibold' : 'font-medium'}`}>
                    {conversation.contact.name ?? conversation.contact.email ?? conversation.contact.externalUserId}
                  </span>
                  {conversation.category === null ? null : (
                    <StatusBadge tone={Tones.neutral}>{labelOf(conversation.category)}</StatusBadge>
                  )}
                </span>
                <span className="truncate text-sm text-muted-foreground">{conversation.preview}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <Ago date={conversation.lastMessageAt} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Settings({ workspaceId, projectId, categories }: Props & { categories: readonly MessengerCategory[] }) {
  const utils = trpc.useUtils();
  const [drafts, setDrafts] = useState(categories.map(category => category.label));
  const [newLabel, setNewLabel] = useState('');
  const [isConfirmingRotate, setIsConfirmingRotate] = useState(false);
  const save = trpc.messenger.setCategories.useMutation({
    onSuccess: async () => {
      await utils.messenger.settings.invalidate();
    },
  });
  const rotate = trpc.messenger.rotateSecret.useMutation({
    onSuccess: () => {
      setIsConfirmingRotate(false);
    },
  });
  // eslint-disable-next-line sonarjs/null-dereference -- newLabel is a useState<string>, never null
  const trimmedNew = newLabel.trim();
  const updateDraft = (index: number, value: string) => {
    setDrafts(previous => previous.map((label, at) => (at === index ? value : label)));
  };
  const edited = categories.map((category, index) => ({ key: category.key, label: drafts[index] ?? category.label }));

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-medium">Settings</h2>
      <form
        aria-label="Categories"
        className="flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault();
          save.mutate({
            workspaceId,
            projectId,
            categories: trimmedNew === '' ? edited : [...edited, { key: keyOf(trimmedNew), label: trimmedNew }],
          });
          setNewLabel('');
        }}>
        <p className="text-xs text-muted-foreground">
          What users pick when they write. Your app shows these labels (or its own translations of the keys).
        </p>
        <ul className="flex flex-col gap-2">
          {categories.map((category, index) => (
            <li key={category.key} className="flex items-center gap-2">
              <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{category.key}</span>
              <input
                aria-label={`Label for ${category.key}`}
                value={drafts[index] ?? category.label}
                maxLength={60}
                onChange={event => {
                  updateDraft(index, event.target.value);
                }}
                className={`${inputClass} flex-1`}
              />
            </li>
          ))}
          <li className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">New</span>
            <input
              aria-label="New category"
              value={newLabel}
              maxLength={60}
              placeholder="Account deletion"
              onChange={event => {
                setNewLabel(event.target.value);
              }}
              className={`${inputClass} flex-1`}
            />
          </li>
        </ul>
        {save.error ? <p className="text-sm text-destructive">{errorMessage(save.error)}</p> : null}
        <Button type="submit" variant="outline" pending={save.isPending} className="w-fit text-sm">
          Save categories
        </Button>
      </form>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Identity secret</h3>
        <p className="max-w-prose text-xs text-muted-foreground">
          Rotate it if it leaked. Signatures made with the old secret stop working at once, so update your server right
          after.
        </p>
        {rotate.data ? <SecretNotice secret={rotate.data.identitySecret} title="New identity secret" /> : null}
        {isConfirmingRotate ? (
          <span className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              className="text-sm"
              pending={rotate.isPending}
              onClick={() => {
                rotate.mutate({ workspaceId, projectId });
              }}>
              Rotate now
            </Button>
            <Button
              variant="ghost"
              className="text-sm"
              onClick={() => {
                setIsConfirmingRotate(false);
              }}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="outline"
            className="w-fit text-sm"
            onClick={() => {
              setIsConfirmingRotate(true);
            }}>
            Rotate secret
          </Button>
        )}
        {rotate.error ? <p className="text-sm text-destructive">{errorMessage(rotate.error)}</p> : null}
      </div>
    </section>
  );
}

export default function Inbox({ workspaceId, projectId }: Props) {
  const settingsQuery = trpc.messenger.settings.useQuery({ workspaceId, projectId });
  if (settingsQuery.isPending) {
    return <Spinner />;
  }
  if (settingsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(settingsQuery.error)}</p>;
  }
  const { settings } = settingsQuery.data;
  if (settings === null) {
    return <Setup workspaceId={workspaceId} projectId={projectId} />;
  }
  return (
    <div className="flex flex-col gap-8">
      <Conversations workspaceId={workspaceId} projectId={projectId} categories={settings.categories} />
      <Settings
        // Saved categories start a fresh draft.
        key={settings.categories.map(category => `${category.key}:${category.label}`).join('|')}
        workspaceId={workspaceId}
        projectId={projectId}
        categories={settings.categories}
      />
    </div>
  );
}
