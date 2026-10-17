// A "what's new" badge's state, headless (#177): the unread count of a board's changelog, its
// newest entries and marking them seen, for the web widget (`@mocco/js/whats-new`) and the
// React Native hook (`@mocco/react-native/whats-new`) to draw. A subpath of its own
// (`@mocco/sdk-core/whats-new`); it imports the feedback client by name, so the built files
// share one `FeedbackClient` and `MoccoError`.
import { FeedbackClient } from '@mocco/sdk-core/feedback';

import type { FeedbackBoardClient, FeedbackChangelogEntry, FeedbackClientOptions } from '@mocco/sdk-core/feedback';

/** The part of localStorage (or AsyncStorage) "what's new" keeps a visitor's cursor in. */
export interface WhatsNewStorage {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
}

export interface WhatsNewOptions extends FeedbackClientOptions {
  /** The board whose changelog to show (its slug). */
  board: string;
  /** Keeps when this device last looked, for visitors who aren't signed in. In memory without it. */
  storage?: WhatsNewStorage;
  /** How many entries `loadEntries` reads (default 10). */
  pageSize?: number;
}

export interface WhatsNewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Entries published since the user last looked (up to 100). */
  unreadCount: number;
  /** The newest entries, once `loadEntries` has run. */
  entries: FeedbackChangelogEntry[];
  /** When the user (or this device) last looked, or null before the first time. */
  lastSeenAt: string | null;
  error: Error | null;
}

const STORAGE_KEY = 'mocco-whats-new:v1';
const DEFAULT_PAGE_SIZE = 10;

const initialState: WhatsNewState = { status: 'idle', unreadCount: 0, entries: [], lastSeenAt: null, error: null };

const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** The later of two ISO timestamps (either may be missing). */
const laterOf = (a: string | null, b: string | null): string | null => {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

/**
 * One board's "what's new" state. Signed in (`endUserToken` returns a token), the cursor is
 * the end user's own on Mocco, so it follows them across devices; anonymous, it is the newest
 * entry this device has seen, kept in `storage`. Create it once; `subscribe` and `getState`
 * fit `useSyncExternalStore`.
 */
export class WhatsNew {
  private state: WhatsNewState = initialState;

  private readonly listeners = new Set<() => void>();

  private readonly storageKey: string;

  private memoryCursor: string | null = null;

  readonly feedback: FeedbackClient;

  readonly board: FeedbackBoardClient;

  getState = (): WhatsNewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  constructor(private readonly options: WhatsNewOptions) {
    this.feedback = new FeedbackClient(options);
    this.board = this.feedback.board(options.board);
    // Per key and board: a build with another project's key starts fresh.
    this.storageKey = `${STORAGE_KEY}:${options.publishableKey.slice(-8)}:${options.board}`;
  }

  private setState(patch: Partial<WhatsNewState>): void {
    this.state = { ...this.state, ...patch };
    // eslint-disable-next-line no-restricted-syntax -- listeners run for their side effects
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async readCursor(): Promise<string | null> {
    try {
      const stored = await this.options.storage?.getItem(this.storageKey);
      return laterOf(typeof stored === 'string' && stored !== '' ? stored : null, this.memoryCursor);
    } catch {
      return this.memoryCursor;
    }
  }

  private async writeCursor(at: string): Promise<void> {
    const cursor = laterOf(at, this.memoryCursor) ?? at;
    this.memoryCursor = cursor;
    try {
      await this.options.storage?.setItem(this.storageKey, cursor);
    } catch {
      // Kept in memory for this session.
    }
  }

  /** The unread count, fetched now; rejects when Mocco can't be reached or refuses. */
  async unreadCount(): Promise<number> {
    if (this.state.status === 'idle') {
      this.setState({ status: 'loading' });
    }
    try {
      const since = await this.readCursor();
      const unread = await this.board.changelogUnread(since === null ? {} : { since });
      this.setState({ status: 'ready', unreadCount: unread.count, lastSeenAt: unread.lastSeenAt, error: null });
      return unread.count;
    } catch (error) {
      this.setState({ status: 'error', error: errorOf(error) });
      throw error;
    }
  }

  /** `unreadCount` for a UI: never rejects (a failure lands in `error`; the last count stays). */
  async refresh(): Promise<void> {
    try {
      await this.unreadCount();
    } catch {
      // In state.error.
    }
  }

  /** The newest entries (`pageSize` of them), kept in the state. */
  async loadEntries(): Promise<FeedbackChangelogEntry[]> {
    try {
      const page = await this.board.changelog({ limit: this.options.pageSize ?? DEFAULT_PAGE_SIZE });
      this.setState({ status: 'ready', entries: page.entries, error: null });
      return page.entries;
    } catch (error) {
      this.setState({ status: 'error', error: errorOf(error) });
      throw error;
    }
  }

  /**
   * The user has seen every entry: the badge goes to zero. Signed in, Mocco moves their cursor
   * (the key needs feedback:write); either way the device keeps the newest entry's date, so a
   * visitor's badge counts only what comes after it, whatever the device's clock says.
   */
  async markSeen(): Promise<void> {
    try {
      let newest = this.state.entries[0]?.publishedAt;
      if (newest === undefined) {
        const latest = await this.board.changelog({ limit: 1 });
        newest = latest.entries[0]?.publishedAt;
      }
      if (newest !== undefined) {
        await this.writeCursor(newest);
      }
      let lastSeenAt = newest ?? null;
      if ((await this.feedback.endUserToken()) !== null) {
        const seen = await this.board.markChangelogSeen();
        ({ lastSeenAt } = seen);
      }
      this.setState({ status: 'ready', unreadCount: 0, lastSeenAt: laterOf(lastSeenAt, this.state.lastSeenAt) });
    } catch (error) {
      this.setState({ status: 'error', error: errorOf(error) });
      throw error;
    }
  }
}
