// One messenger conversation (#95): the thread with internal notes marked, a composer
// that replies or adds a note (with images and PDFs attached, #430), open/closed, who it is
// assigned to (changed by hand from the header), and a side panel with who the user is and
// what they were running when they wrote.
import {
  ATTACHMENT_CONTENT_TYPES,
  isImageAttachment,
  MessageVisibilities,
  MessengerLimits,
} from '@mocco/common/messenger';
import { DownloadIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';

import { INBOX_REFRESH_MS } from '@frontend/components/messenger/inbox';
import { replyAttachmentProblem, useReplyAttachments } from '@frontend/components/messenger/use-reply-attachments';
import {
  Ago,
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn, formatBytes } from '@frontend/lib/utils';

import type { MessengerContext } from '@mocco/common/messenger';

interface Props {
  workspaceId: string;
  projectId: string;
  conversationId: string;
}

const contextLabels: Record<keyof MessengerContext, string> = {
  appVersion: 'App version',
  build: 'Build',
  platform: 'Platform',
  os: 'OS',
  device: 'Device',
  locale: 'Language',
  timezone: 'Time zone',
  screen: 'Screen',
  sdkVersion: 'SDK',
};

/** Label/value rows, skipping empty values. */
function Facts({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing reported.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const contextRows = (context: MessengerContext): [string, string][] =>
  (Object.keys(contextLabels) as (keyof MessengerContext)[]).flatMap(key => {
    const value = context[key];
    return value === undefined ? [] : [[contextLabels[key], value] as [string, string]];
  });

function Composer({ workspaceId, projectId, conversationId }: Props) {
  const utils = trpc.useUtils();
  const [body, setBody] = useState('');
  const [isNote, setIsNote] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const attachments = useReplyAttachments(workspaceId, projectId, conversationId);
  const write = trpc.messenger.write.useMutation({
    onSuccess: async () => {
      setBody('');
      setFiles([]);
      await utils.messenger.conversation.invalidate({ workspaceId, projectId, conversationId });
      await utils.messenger.inbox.invalidate();
    },
  });
  // eslint-disable-next-line sonarjs/null-dereference -- body is a useState<string>, never null
  const trimmed = body.trim();
  const isFull = files.length >= MessengerLimits.attachmentsPerMessage;

  const add = (picked: File[]) => {
    const firstProblem = picked.map(file => replyAttachmentProblem(file)).find(entry => entry !== null);
    const fitting = picked.filter(file => replyAttachmentProblem(file) === null);
    const room = MessengerLimits.attachmentsPerMessage - files.length;
    setFiles([...files, ...fitting.slice(0, room)]);
    setProblem(
      firstProblem ??
        (fitting.length > room ? `A message carries up to ${MessengerLimits.attachmentsPerMessage} files.` : null),
    );
  };

  const send = async () => {
    setProblem(null);
    try {
      const attachmentIds = await attachments.upload(files);
      await write.mutateAsync({
        workspaceId,
        projectId,
        conversationId,
        body: trimmed,
        internal: isNote,
        ...(attachmentIds.length > 0 && { attachmentIds }),
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The message could not be sent.');
    }
  };

  return (
    <form
      aria-label="Write"
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-3',
        isNote ? 'border-dashed border-amber-500/60 bg-amber-500/5' : 'border-border',
      )}
      onSubmit={event => {
        event.preventDefault();
        fireAndForget(send());
      }}>
      <div role="radiogroup" aria-label="Kind" className="flex gap-1 text-sm">
        {[
          { value: false, label: 'Reply' },
          { value: true, label: 'Internal note' },
        ].map(option => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={isNote === option.value}
            onClick={() => {
              setIsNote(option.value);
            }}
            className={cn(
              'rounded-md px-2 py-1',
              isNote === option.value ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
            )}>
            {option.label}
          </button>
        ))}
      </div>
      <textarea
        aria-label={isNote ? 'Internal note' : 'Reply'}
        value={body}
        rows={4}
        maxLength={8000}
        placeholder={isNote ? 'Only your team sees this.' : 'The user sees this in the app.'}
        onChange={event => {
          setBody(event.target.value);
        }}
        className={cn(inputClass, 'h-auto py-2')}
      />
      {files.length === 0 ? null : (
        <ul aria-label="Attached files" className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${String(index)}`}
              className="flex max-w-64 items-center gap-2 rounded-lg border border-border bg-background px-2 py-1 text-sm">
              {file.type.startsWith('image/') ? (
                <ImageIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{file.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                className="rounded text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setFiles(files.filter((_, at) => at !== index));
                }}>
                <XIcon aria-hidden className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(problem ?? errorMessage(write.error)) === null ? null : (
        <p className="text-sm text-destructive">{problem ?? errorMessage(write.error)}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          pending={write.isPending || attachments.isUploading}
          disabled={trimmed === ''}
          className="w-fit text-sm">
          {isNote ? 'Add note' : 'Send reply'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="text-sm"
          disabled={isFull}
          onClick={() => {
            pickerRef.current?.click();
          }}>
          <PaperclipIcon aria-hidden className="size-4" />
          Attach
        </Button>
        <span className="text-xs text-muted-foreground">
          Images or PDFs, up to {MessengerLimits.attachmentsPerMessage}, 10 MB each
        </span>
        <input
          ref={pickerRef}
          type="file"
          accept={ATTACHMENT_CONTENT_TYPES.join(',')}
          multiple
          hidden
          aria-label="Files to attach"
          onChange={event => {
            add([...(event.target.files ?? [])]);
            // Picking the same file again should add it again.
            if (pickerRef.current !== null) {
              pickerRef.current.value = '';
            }
          }}
        />
      </div>
    </form>
  );
}

export default function Conversation({ workspaceId, projectId, conversationId }: Props) {
  const utils = trpc.useUtils();
  const input = { workspaceId, projectId, conversationId };
  const conversationQuery = trpc.messenger.conversation.useQuery(input, { refetchInterval: INBOX_REFRESH_MS });
  const settingsQuery = trpc.messenger.settings.useQuery({ workspaceId, projectId });
  const markRead = trpc.messenger.markRead.useMutation({
    onSuccess: async () => {
      await utils.messenger.inbox.invalidate();
    },
  });
  const statusChange = trpc.messenger.setStatus.useMutation({
    onSuccess: async () => {
      await utils.messenger.conversation.invalidate(input);
      await utils.messenger.inbox.invalidate();
    },
  });
  const blocking = trpc.messenger.setContactBlocked.useMutation({
    onSuccess: async () => {
      await utils.messenger.conversation.invalidate(input);
    },
  });
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const assigning = trpc.messenger.assign.useMutation({
    onSuccess: async () => {
      await utils.messenger.conversation.invalidate(input);
      await utils.messenger.inbox.invalidate();
    },
  });
  const router = useRouter();
  const [isConfirmingErase, setIsConfirmingErase] = useState(false);
  const erasing = trpc.messenger.eraseContact.useMutation({
    onSuccess: async () => {
      await utils.messenger.inbox.invalidate();
      await router.push(Routes.projectInbox(workspaceId, projectId));
    },
  });
  const lastSeq = conversationQuery.data?.conversation.lastMessageSeq;
  const { mutate: markReadNow } = markRead;
  // Reading the thread marks it read, again whenever a new message arrives.
  useEffect(() => {
    if (lastSeq !== undefined) {
      markReadNow({ workspaceId, projectId, conversationId });
    }
  }, [lastSeq, markReadNow, workspaceId, projectId, conversationId]);

  if (conversationQuery.isPending) {
    return <Spinner />;
  }
  if (conversationQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(conversationQuery.error)}</p>;
  }
  const { conversation, contact, assignee, messages } = conversationQuery.data;
  const who = contact.name ?? contact.email ?? contact.externalUserId;
  const category = settingsQuery.data?.settings?.categories.find(entry => entry.key === conversation.category);
  const isOpen = conversation.status === 'open';
  const isBlocked = contact.blockedAt !== null;
  const traits = Object.entries(contact.traits).map(([key, value]) => [key, String(value)] as [string, string]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        <Link href={Routes.projectInbox(workspaceId, projectId)} className="hover:text-foreground">
          Inbox
        </Link>{' '}
        / {who}
      </p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{who}</h2>
            {conversation.category === null ? null : (
              <StatusBadge tone={Tones.neutral}>{category?.label ?? conversation.category}</StatusBadge>
            )}
            <StatusBadge tone={isOpen ? Tones.ok : Tones.neutral}>{isOpen ? 'Open' : 'Closed'}</StatusBadge>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              Assigned to
              <select
                aria-label="Assignee"
                value={assignee?.userId ?? ''}
                disabled={assigning.isPending}
                onChange={event => {
                  assigning.mutate({ ...input, assigneeUserId: event.target.value === '' ? null : event.target.value });
                }}
                className={cn(inputClass, 'h-7 py-0 text-xs')}>
                <option value="">No one</option>
                {/* Someone who has left the workspace keeps the conversation until it is reassigned. */}
                {assignee === null ||
                (membersQuery.data?.members ?? []).some(member => member.userId === assignee.userId) ? null : (
                  <option value={assignee.userId}>{assignee.name ?? 'A former member'}</option>
                )}
                {(membersQuery.data?.members ?? []).map(member => (
                  <option key={member.userId} value={member.userId}>
                    {member.user.name}
                  </option>
                ))}
              </select>
            </label>
            {assigning.error ? <span className="text-xs text-destructive">{errorMessage(assigning.error)}</span> : null}
            <Button
              variant="outline"
              className="ml-auto text-sm"
              pending={statusChange.isPending}
              onClick={() => {
                statusChange.mutate({ ...input, status: isOpen ? 'closed' : 'open' });
              }}>
              {isOpen ? 'Close' : 'Reopen'}
            </Button>
          </div>
          <ol className="flex flex-col gap-3">
            {messages.map(message => {
              const isNote = message.visibility === MessageVisibilities.internal;
              const isTeam = message.authorKind !== 'contact';
              const author = isTeam ? (message.authorName ?? 'Your team') : who;
              return (
                <li key={message.id} className={cn('flex flex-col gap-1', isTeam ? 'items-end' : 'items-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm',
                      isNote && 'border border-dashed border-amber-500/60 bg-amber-500/10',
                      !isNote && isTeam && 'bg-primary text-primary-foreground',
                      !isTeam && 'bg-muted',
                    )}>
                    {isNote ? (
                      <span className="mb-1 block text-xs font-medium text-amber-700 dark:text-amber-400">
                        Internal note
                      </span>
                    ) : null}
                    {message.body}
                    {message.attachments.length === 0 ? null : (
                      <span className="mt-2 flex flex-wrap gap-2">
                        {message.attachments.map((attachment, index) =>
                          isImageAttachment(attachment.contentType) ? (
                            <a
                              key={attachment.id}
                              href={attachment.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block overflow-hidden rounded-lg border border-border bg-background">
                              {/* A short-lived signed link to the user's screenshot; next/image can't proxy it. */}
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={attachment.url}
                                alt={`Attachment ${index + 1} from ${author}`}
                                className="h-32 w-auto max-w-full object-contain"
                              />
                            </a>
                          ) : (
                            // A PDF: the signed link answers as a download, so it never renders here.
                            <a
                              key={attachment.id}
                              href={attachment.url}
                              download={attachment.filename}
                              aria-label={`Download ${attachment.filename} from ${author}`}
                              className="flex max-w-64 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-foreground hover:bg-muted">
                              <FileTextIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium">{attachment.filename}</span>
                                <span className="text-xs text-muted-foreground">
                                  PDF · {formatBytes(attachment.sizeBytes)}
                                </span>
                              </span>
                              <DownloadIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                            </a>
                          ),
                        )}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {author} · <Ago date={message.createdAt} />
                  </span>
                </li>
              );
            })}
          </ol>
          {isBlocked ? (
            <p className="text-sm text-muted-foreground">This user is blocked; they can't write any more.</p>
          ) : null}
          <Composer workspaceId={workspaceId} projectId={projectId} conversationId={conversationId} />
        </section>
        <aside aria-label="About the user" className="flex flex-col gap-4 lg:border-l lg:border-border lg:pl-6">
          <div className="flex flex-col gap-1">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              User
              {contact.externalUserId === null ? <StatusBadge tone={Tones.neutral}>Not signed in</StatusBadge> : null}
            </h3>
            <Facts
              rows={
                [
                  ['Name', contact.name ?? ''],
                  ['Email', contact.email ?? ''],
                  ['User id', contact.externalUserId ?? ''],
                  ['Last seen', contact.lastSeenAt.toLocaleString()],
                  ...traits,
                ].filter(([, value]) => value !== '') as [string, string][]
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Their app now</h3>
            <Facts rows={contextRows(contact.lastContext)} />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">When this started</h3>
            <Facts rows={contextRows(conversation.contextAtOpen)} />
          </div>
          <Button
            variant={isBlocked ? 'outline' : 'destructive'}
            className="w-fit text-sm"
            pending={blocking.isPending}
            onClick={() => {
              blocking.mutate({ workspaceId, projectId, contactId: contact.id, blocked: !isBlocked });
            }}>
            {isBlocked ? 'Unblock user' : 'Block user'}
          </Button>
          {blocking.error ? <p className="text-sm text-destructive">{errorMessage(blocking.error)}</p> : null}
          <div className="flex flex-col gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              For a privacy request: erases this user with every conversation, message and screenshot. It can&apos;t be
              undone.
            </p>
            {isConfirmingErase ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  className="text-sm"
                  pending={erasing.isPending}
                  onClick={() => {
                    erasing.mutate({ workspaceId, projectId, contactId: contact.id });
                  }}>
                  Yes, erase
                </Button>
                <Button
                  variant="outline"
                  className="text-sm"
                  disabled={erasing.isPending}
                  onClick={() => {
                    setIsConfirmingErase(false);
                  }}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-fit text-sm text-destructive"
                onClick={() => {
                  setIsConfirmingErase(true);
                }}>
                Erase user&apos;s data
              </Button>
            )}
            {erasing.error ? <p className="text-sm text-destructive">{errorMessage(erasing.error)}</p> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
