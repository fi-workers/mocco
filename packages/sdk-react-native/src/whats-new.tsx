// The `@mocco/react-native/whats-new` entry (#177): a board's changelog in the app. Create one
// `WhatsNew` with `createWhatsNew` (outside a component), then `useWhatsNew` gives the unread
// count, the newest entries and `markSeen`, and `<WhatsNewBadge />` draws the count. The app
// draws the list in its own design. Pure JS, so it runs in Expo Go.
import { WhatsNew } from '@mocco/sdk-core/whats-new';
import { useEffect, useSyncExternalStore } from 'react';
// eslint-disable-next-line import-x/no-unresolved -- a peer dependency the app installs
import { AppState, Text, View } from 'react-native';

import type { FeedbackChangelogEntry } from '@mocco/sdk-core/feedback';
import type { WhatsNewOptions, WhatsNewState } from '@mocco/sdk-core/whats-new';

export type {
  EndUserTokenSource,
  FeedbackChangelogEntry,
  FeedbackChangelogPost,
  FeedbackChangelogTag,
} from '@mocco/sdk-core/feedback';
export type { WhatsNewOptions, WhatsNewState, WhatsNewStorage } from '@mocco/sdk-core/whats-new';
export { FeedbackClient } from '@mocco/sdk-core/feedback';
export { WhatsNew } from '@mocco/sdk-core/whats-new';

/**
 * One board's "what's new" for the app; create it once. Pass `storage` (AsyncStorage) so a
 * visitor's "last looked" date survives a restart, and `endUserToken` so a signed-in user's
 * read mark is theirs on Mocco, on every device.
 */
export function createWhatsNew(options: WhatsNewOptions): WhatsNew {
  return new WhatsNew(options);
}

/**
 * The unread count and the newest entries, re-rendering when they change. The count is
 * fetched on mount and whenever the app comes back to the foreground; pass
 * `loadEntries: true` on the screen that lists the entries.
 */
export function useWhatsNew(
  whatsNew: WhatsNew,
  opts: { loadEntries?: boolean } = {},
): {
  unreadCount: number;
  entries: FeedbackChangelogEntry[];
  status: WhatsNewState['status'];
  error: Error | null;
  refresh: () => Promise<void>;
  /** The user has seen every entry: the count goes to zero. */
  markSeen: () => Promise<void>;
} {
  const state = useSyncExternalStore(whatsNew.subscribe, whatsNew.getState, whatsNew.getState);
  const shouldLoadEntries = opts.loadEntries ?? false;
  useEffect(() => {
    // eslint-disable-next-line no-void -- runs in the background; refresh() never rejects
    void whatsNew.refresh();
    const subscription = AppState.addEventListener('change', appState => {
      if (appState === 'active') {
        // eslint-disable-next-line no-void -- runs in the background; refresh() never rejects
        void whatsNew.refresh();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [whatsNew]);
  useEffect(() => {
    if (shouldLoadEntries) {
      // eslint-disable-next-line no-void -- a failure lands in the state's error
      void whatsNew.loadEntries().catch(() => undefined);
    }
  }, [whatsNew, shouldLoadEntries]);
  return {
    unreadCount: state.unreadCount,
    entries: state.entries,
    status: state.status,
    error: state.error,
    refresh: whatsNew.refresh.bind(whatsNew),
    markSeen: whatsNew.markSeen.bind(whatsNew),
  };
}

/** The badge's text: the count, or `99+`. */
const badgeTextOf = (count: number): string => (count > 99 ? '99+' : String(count));

/**
 * A small round badge with the unread count, drawn only when there is something new. Style it
 * with `style` (the circle) and `textStyle`; `label` is what screen readers say.
 */
// eslint-disable-next-line sonarjs/function-return-type -- a component renders the badge or nothing
export function WhatsNewBadge({
  whatsNew,
  style,
  textStyle,
  label = count => `${count} unread updates`,
}: {
  whatsNew: WhatsNew;
  style?: object;
  textStyle?: object;
  label?: (count: number) => string;
}) {
  const { unreadCount } = useWhatsNew(whatsNew);
  if (unreadCount === 0) {
    return null;
  }
  return (
    <View
      accessibilityLabel={label(unreadCount)}
      style={[
        {
          minWidth: 18,
          height: 18,
          paddingHorizontal: 5,
          borderRadius: 9,
          backgroundColor: '#e5484d',
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}>
      <Text style={[{ color: '#fff', fontSize: 11, fontWeight: '600' }, textStyle]}>{badgeTextOf(unreadCount)}</Text>
    </View>
  );
}
