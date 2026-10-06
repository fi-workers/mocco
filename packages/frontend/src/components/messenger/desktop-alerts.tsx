// Browser notifications for the inbox (#204): while the inbox tab is open, each new
// conversation its poll finds raises a system notification (the Notification API), once
// the person has allowed them. Nothing runs when the tab is closed; Slack or Discord
// rules cover that.
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';

interface InboxRow {
  id: string;
  preview: string;
  contact: { name: string | null; email: string | null; externalUserId: string | null };
}

const isSupported = () => 'Notification' in globalThis;

const permissionNow = (): NotificationPermission | 'unsupported' =>
  isSupported() ? Notification.permission : 'unsupported';

/** Show one conversation's notification; clicking it brings the tab forward and runs `open`. */
function notify(conversation: InboxRow, open: () => void) {
  const { contact } = conversation;
  const notification = new Notification(
    `New conversation from ${contact.name ?? contact.email ?? contact.externalUserId ?? 'a guest'}`,
    { body: conversation.preview, tag: `mocco-messenger:${conversation.id}` },
  );
  notification.addEventListener(
    'click',
    () => {
      // eslint-disable-next-line no-restricted-globals -- this tab's own focus, to bring it forward
      focus();
      open();
      notification.close();
    },
    { once: true },
  );
}

/**
 * Notify about conversations that appear in `conversations` after the first load. The
 * first list is what the person already sees, so it raises nothing. Each notification is
 * tagged with its conversation, so the browser shows one per conversation.
 */
export function useNewConversationAlerts(
  scope: { workspaceId: string; projectId: string },
  conversations: readonly InboxRow[] | undefined,
) {
  const router = useRouter();
  const seenRef = useRef<Set<string> | null>(null);
  const { workspaceId, projectId } = scope;

  useEffect(() => {
    if (conversations === undefined) {
      return;
    }
    const known = seenRef.current;
    seenRef.current = new Set([...(known ?? []), ...conversations.map(conversation => conversation.id)]);
    if (known === null || permissionNow() !== 'granted') {
      return;
    }
    const arrived = conversations.filter(row => !known.has(row.id));
    // eslint-disable-next-line no-restricted-syntax -- one notification per new conversation is a side effect
    for (const conversation of arrived) {
      notify(conversation, () => {
        fireAndForget(router.push(Routes.projectConversation(workspaceId, projectId, conversation.id)));
      });
    }
  }, [conversations, router, workspaceId, projectId]);
}

/** Ask for permission, or say where things stand. Hidden where the browser has no Notification API. */
export function DesktopAlertsToggle() {
  const [permission, setPermission] = useState(permissionNow);
  if (permission === 'unsupported') {
    return null;
  }
  if (permission === 'granted') {
    return <span className="text-xs text-muted-foreground">Desktop notifications on while this tab is open</span>;
  }
  if (permission === 'denied') {
    return <span className="text-xs text-muted-foreground">Desktop notifications are blocked in this browser</span>;
  }
  return (
    <Button
      variant="ghost"
      className="text-xs"
      onClick={() => {
        fireAndForget(
          (async () => {
            setPermission(await Notification.requestPermission());
          })(),
        );
      }}>
      Turn on desktop notifications
    </Button>
  );
}
