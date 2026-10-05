// The `@mocco/react-native/messenger` entry (#95): in-app contact with the app's team.
// Headless: hooks give the app the data and actions, and the app draws the screens in
// its own design and languages. Create one client with `createMessenger`, wrap the app
// in `<MessengerProvider>`, then use the hooks. Pure JS, so it runs in Expo Go.
import { HelpClient, MessengerClient } from '@mocco/sdk-core';
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
// eslint-disable-next-line import-x/no-unresolved -- a peer dependency the app installs
import { AppState } from 'react-native';

import type {
  HelpArticleHit,
  HelpSearchOptions,
  HelpClientOptions,
  MessengerCategory,
  MessengerClientOptions,
  MessengerConversation,
  MessengerMessage,
  MessengerState,
} from '@mocco/sdk-core';
import type { ReactNode } from 'react';

export type {
  HelpArticle,
  HelpArticleEntry,
  HelpArticleHit,
  HelpCollection,
  HelpFeedback,
  HelpFeedbackResult,
  HelpReadOptions,
  HelpSearchOptions,
  HelpClientOptions,
  HelpSite,
  MessengerAttachment,
  MessengerCategory,
  MessengerClientOptions,
  MessengerConversation,
  MessengerIdentity,
  MessengerMessage,
  MessengerState,
  MessengerStorage,
} from '@mocco/sdk-core';
export { HelpClient, MessengerClient, MoccoError, MoccoNetworkError, messengerConversationIdOf } from '@mocco/sdk-core';

/** One client for the app; create it once (outside a component). */
export function createMessenger(options: MessengerClientOptions): MessengerClient {
  return new MessengerClient(options);
}

const MessengerContext = createContext<MessengerClient | null>(null);

/**
 * Makes the client available to the hooks. Polling pauses while the app is in the
 * background and refreshes when it returns, so the unread badge is current.
 */
export function MessengerProvider({ client, children }: { client: MessengerClient; children: ReactNode }) {
  useEffect(() => {
    // eslint-disable-next-line no-void -- runs in the background; refresh() never rejects
    void client.refresh();
    const subscription = AppState.addEventListener('change', state => {
      const isActive = state === 'active';
      client.setActive(isActive);
      if (isActive) {
        // eslint-disable-next-line no-void -- runs in the background; refresh() never rejects
        void client.refresh();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [client]);
  return <MessengerContext.Provider value={client}>{children}</MessengerContext.Provider>;
}

/** The client, for actions the hooks don't cover: `attach` a screenshot or PDF, `registerPushToken`, `signOut` after the user signs out. */
export function useMessenger(): MessengerClient {
  const client = useContext(MessengerContext);
  if (client === null) {
    throw new Error('Wrap the app in <MessengerProvider client={…}>');
  }
  return client;
}

/** The whole messenger state, re-rendering when it changes. */
export function useMessengerState(): MessengerState {
  const client = useMessenger();
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

/** How many conversations have a reply the user hasn't read (for a badge). */
export function useUnreadCount(): number {
  return useMessengerState().unreadCount;
}

/** The categories users pick from when they start a conversation. */
export function useMessengerCategories(): MessengerCategory[] {
  return useMessengerState().categories;
}

/** The user's conversations, kept fresh while the screen is mounted, and `start` for a new one. */
export function useConversations(): {
  conversations: MessengerConversation[];
  status: MessengerState['status'];
  error: Error | null;
  refresh: () => Promise<void>;
  start: (input: { body: string; category?: string; attachmentIds?: string[] }) => Promise<MessengerConversation>;
} {
  const client = useMessenger();
  const { conversations, status, error } = useMessengerState();
  useEffect(() => client.watch(), [client]);
  const refresh = useCallback(async () => {
    await client.refresh();
  }, [client]);
  const start = useCallback(
    async (input: { body: string; category?: string; attachmentIds?: string[] }) =>
      await client.startConversation(input),
    [client],
  );
  return { conversations, status, error, refresh, start };
}

/**
 * One conversation's messages, kept fresh while mounted. Seeing new messages marks
 * them read (pass `markRead: false` to do it yourself with the returned `markRead`).
 */
export function useConversation(
  conversationId: string,
  opts: { markRead?: boolean } = {},
): {
  conversation: MessengerConversation | undefined;
  messages: MessengerMessage[];
  /** Send a message, with attachment ids from `useMessenger().attach(…)`. */
  send: (body: string, attachmentIds?: string[]) => Promise<MessengerMessage>;
  isSending: boolean;
  error: Error | null;
  markRead: () => Promise<void>;
} {
  const client = useMessenger();
  const state = useMessengerState();
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<Error | null>(null);
  const messages = state.threads[conversationId] ?? [];
  const lastSeq = messages.at(-1)?.seq;
  const shouldMarkRead = opts.markRead ?? true;
  useEffect(() => client.watch(conversationId), [client, conversationId]);
  useEffect(() => {
    if (shouldMarkRead && lastSeq !== undefined) {
      // eslint-disable-next-line no-void -- an effect can't await; failures are retried on the next message
      void (async () => {
        try {
          await client.markRead(conversationId);
        } catch {
          // Marked on the next new message.
        }
      })();
    }
  }, [client, conversationId, lastSeq, shouldMarkRead]);
  const send = useCallback(
    async (body: string, attachmentIds?: string[]) => {
      setIsSending(true);
      setSendError(null);
      try {
        const message = await client.sendMessage(conversationId, body, attachmentIds);
        setIsSending(false);
        return message;
      } catch (error) {
        setIsSending(false);
        setSendError(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    [client, conversationId],
  );
  const markRead = useCallback(async () => {
    await client.markRead(conversationId);
  }, [client, conversationId]);
  return {
    conversation: state.conversations.find(conversation => conversation.id === conversationId),
    messages,
    send,
    isSending,
    error: sendError,
    markRead,
  };
}

/** A help center client for the app (needs a key with help:read); create it once. */
export function createHelp(options: HelpClientOptions): HelpClient {
  return new HelpClient(options);
}

/**
 * Help articles matching what the user is typing, e.g. on a contact screen: searches
 * 300 ms after the text stops changing. Failures leave the last hits in place.
 */
export function useHelpSearch(
  help: HelpClient,
  query: string,
  opts: HelpSearchOptions = {},
): { hits: HelpArticleHit[]; isSearching: boolean } {
  const [hits, setHits] = useState<HelpArticleHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const { locale, limit, match } = opts;
  useEffect(() => {
    let isCurrent = true;
    const timer = setTimeout(() => {
      setIsSearching(true);
      // eslint-disable-next-line no-void -- a timer callback can't await; the promise handles its own failure
      void (async () => {
        try {
          const found = await help.search(query, {
            ...(locale !== undefined && { locale }),
            ...(limit !== undefined && { limit }),
            ...(match !== undefined && { match }),
          });
          if (isCurrent) {
            setHits(found);
          }
        } catch {
          // Offline or refused: keep the last hits.
        } finally {
          if (isCurrent) {
            setIsSearching(false);
          }
        }
      })();
    }, 300);
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [help, query, locale, limit, match]);
  return { hits, isSearching };
}
