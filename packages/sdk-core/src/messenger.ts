// The headless messenger client (#95): a signed-in user's conversations with the app's
// team, for the platform SDKs to wrap in their own UI bindings. It opens a session with
// the identity the app's server signed, keeps the session token (in the app's storage,
// when given), lists conversations, starts and continues them, and polls while asked to.
// Messages carry a seq, so a refresh fetches only what is new.
import { DEFAULT_BASE_URL, withoutTrailingSlashes } from './client';
import { MoccoError, MoccoKeyError, MoccoNetworkError } from './errors';
import { keyKindOf } from './keys';

import type {
  MessengerAttachmentRequest,
  MessengerAttachmentResponse,
  MessengerAttachmentType,
  MessengerCategory,
  MessengerContext,
  MessengerConversation,
  MessengerMessage,
  MessengerPushTokenRequest,
  MessengerSessionRequest,
  MessengerSessionResponse,
} from './wire';

/** Who the user is, as the app's server signed them (`signIdentity` in @mocco/node). */
export interface MessengerIdentity {
  userId: string;
  userHash: string;
  name?: string;
  email?: string;
  traits?: Record<string, string | number | boolean>;
}

/** The part of AsyncStorage (or localStorage) the client uses to keep its session. */
export interface MessengerStorage {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

export interface MessengerClientOptions {
  /** A publishable key with `messenger:chat`. */
  publishableKey: string;
  baseUrl?: string;
  /**
   * The signed-in user's identity, from your server; null while nobody is signed in.
   * Called whenever the client needs a new session.
   */
  identity: () => Promise<MessengerIdentity | null>;
  /** Attached to new conversations and messages (app version, platform, …). */
  context?: () => MessengerContext;
  /** Keeps the session across launches. */
  storage?: MessengerStorage;
  /** How often `watch` refreshes (default 15 s). */
  pollIntervalMs?: number;
  fetch?: typeof fetch;
}

export interface MessengerState {
  /** `signed_out` until `identity` returns a user or `continueAsGuest` is called. */
  status: 'idle' | 'loading' | 'ready' | 'signed_out' | 'error';
  /** Writing as a guest (not signed in), known by the email they left. */
  isGuest: boolean;
  conversations: MessengerConversation[];
  categories: MessengerCategory[];
  /** Conversations where the team has replied since the user last read. */
  unreadCount: number;
  /** Loaded threads, by conversation id, oldest message first. */
  threads: Readonly<Record<string, MessengerMessage[]>>;
  error: Error | null;
}

interface StoredSession {
  /** null for a guest. */
  userId: string | null;
  token: string;
  expiresAt: string;
  categories: MessengerCategory[];
  /** A guest's device token and the details they left, to reopen their session. */
  guest?: { token: string; email: string; name?: string };
}

const isFresh = (session: StoredSession) => Date.parse(session.expiresAt) > Date.now() + 60_000;

const MESSENGER_PATH = '/messenger';
/** Suffixed per key: a session belongs to one project, so a build with another key starts fresh. */
const STORAGE_KEY = 'mocco-messenger:session:v1';
export const DEFAULT_MESSENGER_POLL_MS = 15_000;
const MIN_POLL_MS = 3000;

/** A random id for idempotent sends (crypto when available). */
function newClientMessageId(): string {
  // Feature-detected: not every React Native runtime has Web Crypto.
  const webCrypto = Reflect.get(globalThis, 'crypto') as { randomUUID?: () => string } | undefined;
  if (webCrypto?.randomUUID !== undefined) {
    return webCrypto.randomUUID();
  }
  // eslint-disable-next-line sonarjs/pseudo-random -- an idempotency id, not a secret
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function problemOf(response: Response): Promise<{ type?: string; title?: string; detail?: string }> {
  try {
    return (await response.json()) as { type?: string; title?: string; detail?: string };
  } catch {
    return { title: `HTTP ${response.status}` };
  }
}

/**
 * The conversation a messenger push notification is about, from its `data`
 * (`{ mocco: 'messenger', conversationId }`), or undefined for any other notification.
 */
export function messengerConversationIdOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { mocco, conversationId } = data as { mocco?: unknown; conversationId?: unknown };
  return mocco === 'messenger' && typeof conversationId === 'string' ? conversationId : undefined;
}

const initialState: MessengerState = {
  status: 'idle',
  isGuest: false,
  conversations: [],
  categories: [],
  unreadCount: 0,
  threads: {},
  error: null,
};

export class MessengerClient {
  private readonly baseUrl: string;

  private readonly storageKey: string;

  private readonly fetchImpl: typeof fetch;

  private readonly pollIntervalMs: number;

  private state: MessengerState = initialState;

  private readonly listeners = new Set<() => void>();

  private session: StoredSession | null = null;

  private sessionLoad: Promise<StoredSession | null> | undefined;

  private listWatchers = 0;

  /** Watched threads and how many watchers each has. */
  private readonly threadWatchers = new Map<string, number>();

  private timer: ReturnType<typeof setInterval> | undefined;

  private pushToken: string | undefined;

  private pushPlatform: MessengerPushTokenRequest['platform'] | undefined;

  getState = (): MessengerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  constructor(private readonly options: MessengerClientOptions) {
    if (keyKindOf(options.publishableKey) !== 'publishable') {
      throw new MoccoKeyError('The messenger uses a publishable key (mk_pub_…) with messenger:chat');
    }
    this.storageKey = `${STORAGE_KEY}:${options.publishableKey.slice(-8)}`;
    this.baseUrl = withoutTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL) + MESSENGER_PATH;
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.pollIntervalMs = Math.max(MIN_POLL_MS, options.pollIntervalMs ?? DEFAULT_MESSENGER_POLL_MS);
  }

  private setState(patch: Partial<MessengerState>): void {
    this.state = { ...this.state, ...patch };
    // eslint-disable-next-line no-restricted-syntax -- listeners run for their side effects
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async readStored(): Promise<StoredSession | null> {
    try {
      const text = await this.options.storage?.getItem(this.storageKey);
      return typeof text === 'string' ? (JSON.parse(text) as StoredSession) : null;
    } catch {
      return null;
    }
  }

  private async writeStored(session: StoredSession | null): Promise<void> {
    try {
      await (session === null
        ? this.options.storage?.removeItem(this.storageKey)
        : this.options.storage?.setItem(this.storageKey, JSON.stringify(session)));
    } catch {
      // Without storage the next launch just opens a new session.
    }
  }

  /** A fresh session from the app's signed identity, or null when signed out. */
  private async createSession(body: MessengerSessionRequest): Promise<MessengerSessionResponse> {
    return await this.send<MessengerSessionResponse>('POST', '/sessions', {
      body: { ...body, ...(this.options.context !== undefined && { context: this.options.context() }) },
      authorization: this.options.publishableKey,
    });
  }

  private async keep(session: StoredSession): Promise<StoredSession> {
    this.session = session;
    await this.writeStored(session);
    this.setState({ categories: session.categories, isGuest: session.userId === null });
    return session;
  }

  /**
   * A session for the signed-in user (moving what this device wrote as a guest to them),
   * else the device's guest session, else none (`signed_out`).
   */
  private async openSession(): Promise<StoredSession | null> {
    const identity = await this.options.identity();
    const stored = await this.readStored();
    if (identity !== null) {
      if (stored !== null && stored.userId === identity.userId && isFresh(stored)) {
        return await this.keep(stored);
      }
      const created = await this.createSession({
        ...identity,
        ...(stored?.guest !== undefined && { guestToken: stored.guest.token }),
      });
      return await this.keep({
        userId: identity.userId,
        token: created.sessionToken,
        expiresAt: created.expiresAt,
        categories: created.categories,
      });
    }
    if (stored?.guest !== undefined) {
      if (isFresh(stored)) {
        return await this.keep(stored);
      }
      return await this.openGuest(stored.guest);
    }
    this.session = null;
    await this.writeStored(null);
    this.setState({ ...initialState, status: 'signed_out' });
    return null;
  }

  private async openGuest(guest: { token?: string; email: string; name?: string }): Promise<StoredSession> {
    const created = await this.createSession({
      guest: true,
      email: guest.email,
      ...(guest.name !== undefined && { name: guest.name }),
      ...(guest.token !== undefined && { guestToken: guest.token }),
    });
    return await this.keep({
      userId: null,
      token: created.sessionToken,
      expiresAt: created.expiresAt,
      categories: created.categories,
      guest: {
        token: created.guestToken ?? guest.token ?? '',
        email: guest.email,
        ...(guest.name !== undefined && { name: guest.name }),
      },
    });
  }

  /** The session, opening one at most once at a time. */
  private async requireSession(): Promise<StoredSession | null> {
    if (this.session !== null) {
      return this.session;
    }
    this.sessionLoad ??= (async () => {
      try {
        return await this.openSession();
      } finally {
        this.sessionLoad = undefined;
      }
    })();
    return await this.sessionLoad;
  }

  private async send<T>(method: string, path: string, opts: { body?: unknown; authorization: string }): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.authorization}`,
          accept: 'application/json',
          ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      });
    } catch (error) {
      throw new MoccoNetworkError(`Couldn't reach Mocco at ${this.baseUrl}`, { cause: error });
    }
    if (!response.ok) {
      throw new MoccoError(response.status, await problemOf(response));
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  /** A call with the session token; an expired or revoked session is reopened once. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const session = await this.requireSession();
    if (session === null) {
      return null;
    }
    try {
      return await this.send<T>(method, path, { body, authorization: session.token });
    } catch (error) {
      if (!(error instanceof MoccoError) || error.status !== 401) {
        throw error;
      }
      this.session = null;
      await this.writeStored(null);
      const fresh = await this.requireSession();
      return fresh === null ? null : await this.send<T>(method, path, { body, authorization: fresh.token });
    }
  }

  /** A send that is safe to repeat (it carries a client message id): retried once if the network fails. */
  private async callIdempotent<T>(method: string, path: string, body: unknown): Promise<T | null> {
    try {
      return await this.call<T>(method, path, body);
    } catch (error) {
      if (!(error instanceof MoccoNetworkError)) {
        throw error;
      }
      return await this.call<T>(method, path, body);
    }
  }

  private context(): MessengerContext | undefined {
    return this.options.context?.();
  }

  private mergeThread(conversationId: string, messages: MessengerMessage[]): MessengerMessage[] {
    const existing = this.state.threads[conversationId] ?? [];
    const seen = new Set(existing.map(message => message.seq));
    // eslint-disable-next-line unicorn/no-array-sort -- a fresh array; older Hermes lacks toSorted
    const merged = [...existing, ...messages.filter(message => !seen.has(message.seq))].sort((a, b) => a.seq - b.seq);
    this.setState({ threads: { ...this.state.threads, [conversationId]: merged } });
    return merged;
  }

  private startTimer(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; tick() never rejects
      void this.tick();
    }, this.pollIntervalMs);
  }

  private isWatched(): boolean {
    return this.listWatchers > 0 || this.threadWatchers.size > 0;
  }

  private stopTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll: the list, and every watched thread. Never rejects. */
  private async tick(): Promise<void> {
    await this.refresh();
    await Promise.all(
      Array.from(this.threadWatchers.keys(), async id => {
        try {
          await this.loadThread(id);
        } catch {
          // The next poll tries again.
        }
      }),
    );
  }

  /** Fetch the user's conversations. Never rejects: failures land in `state.error`. */
  async refresh(): Promise<void> {
    if (this.state.status === 'idle') {
      this.setState({ status: 'loading' });
    }
    try {
      const answer = await this.call<{ conversations: MessengerConversation[] }>('GET', '/conversations');
      if (answer === null) {
        return;
      }
      this.setState({
        status: 'ready',
        conversations: answer.conversations,
        unreadCount: answer.conversations.filter(conversation => conversation.hasUnread).length,
        categories: this.session?.categories ?? this.state.categories,
        error: null,
      });
    } catch (error) {
      this.setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  /**
   * Upload a screenshot (PNG, JPEG, WebP or GIF, up to 10 MB) and return its id, to pass
   * as `attachmentIds` when starting or continuing a conversation. In React Native, pass
   * bytes (`new Uint8Array(await (await fetch(uri)).arrayBuffer())`): with a Blob, RN
   * replaces the upload's Content-Type and the upload is refused.
   */
  async attach(input: {
    body: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>;
    contentType: MessengerAttachmentType;
    sizeBytes: number;
    filename?: string;
  }): Promise<string> {
    const request: MessengerAttachmentRequest = {
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      ...(input.filename !== undefined && { filename: input.filename }),
    };
    const reserved = await this.call<MessengerAttachmentResponse>('POST', '/attachments', request);
    if (reserved === null) {
      throw new MoccoKeyError('Nobody is signed in');
    }
    let uploaded: Response;
    try {
      uploaded = await this.fetchImpl(reserved.upload.url, {
        method: reserved.upload.method,
        headers: reserved.upload.headers,
        body: input.body,
      });
    } catch (error) {
      throw new MoccoNetworkError("Couldn't upload the attachment", { cause: error });
    }
    if (!uploaded.ok) {
      throw new MoccoError(uploaded.status, { title: 'The attachment upload was refused' });
    }
    return reserved.attachmentId;
  }

  /** Start a conversation with its first message. Retries reuse one client message id. */
  async startConversation(input: {
    body: string;
    category?: string;
    attachmentIds?: string[];
  }): Promise<MessengerConversation> {
    const clientMessageId = newClientMessageId();
    const context = this.context();
    const answer = await this.callIdempotent<{ conversation: MessengerConversation }>('POST', '/conversations', {
      body: input.body,
      clientMessageId,
      ...(input.category !== undefined && { category: input.category }),
      ...(input.attachmentIds !== undefined &&
        input.attachmentIds.length > 0 && { attachmentIds: input.attachmentIds }),
      ...(context !== undefined && { context }),
    });
    if (answer === null) {
      throw new MoccoKeyError('Nobody is signed in');
    }
    await this.refresh();
    return answer.conversation;
  }

  /** Load a thread's new messages (all of them the first time). */
  async loadThread(conversationId: string): Promise<MessengerMessage[]> {
    const afterSeq = this.state.threads[conversationId]?.at(-1)?.seq ?? 0;
    const answer = await this.call<{ messages: MessengerMessage[] }>(
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}/messages?afterSeq=${afterSeq}`,
    );
    return answer === null ? [] : this.mergeThread(conversationId, answer.messages);
  }

  /** Write in a conversation. A network failure is retried once with the same client message id. */
  async sendMessage(conversationId: string, body: string, attachmentIds: string[] = []): Promise<MessengerMessage> {
    const context = this.context();
    const answer = await this.callIdempotent<{ message: MessengerMessage }>(
      'POST',
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        body,
        clientMessageId: newClientMessageId(),
        ...(attachmentIds.length > 0 && { attachmentIds }),
        ...(context !== undefined && { context }),
      },
    );
    if (answer === null) {
      throw new MoccoKeyError('Nobody is signed in');
    }
    // A thread not loaded yet is fetched whole, so the cache never starts mid-thread.
    await (this.state.threads[conversationId] === undefined
      ? this.loadThread(conversationId)
      : Promise.resolve(this.mergeThread(conversationId, [answer.message])));
    await this.refresh();
    return answer.message;
  }

  /** Mark a thread read up to its newest loaded message. */
  async markRead(conversationId: string): Promise<void> {
    const seq = this.state.threads[conversationId]?.at(-1)?.seq;
    if (seq === undefined) {
      return;
    }
    await this.call('POST', `/conversations/${encodeURIComponent(conversationId)}/read`, { seq });
    this.setState({
      conversations: this.state.conversations.map(conversation =>
        conversation.id === conversationId ? { ...conversation, hasUnread: false } : conversation,
      ),
      unreadCount: this.state.conversations.filter(
        conversation => conversation.hasUnread && conversation.id !== conversationId,
      ).length,
    });
  }

  /**
   * Keep the list (and, with an id, that thread) fresh until the returned stop is
   * called. Refreshes at once, then every poll interval while anything is watched.
   */
  watch(conversationId?: string): () => void {
    if (conversationId === undefined) {
      this.listWatchers += 1;
    } else {
      this.threadWatchers.set(conversationId, (this.threadWatchers.get(conversationId) ?? 0) + 1);
    }
    this.startTimer();
    // eslint-disable-next-line no-void -- runs in the background; tick() never rejects
    void this.tick();
    return () => {
      if (conversationId === undefined) {
        this.listWatchers = Math.max(0, this.listWatchers - 1);
      } else {
        const left = (this.threadWatchers.get(conversationId) ?? 1) - 1;
        if (left <= 0) {
          this.threadWatchers.delete(conversationId);
        } else {
          this.threadWatchers.set(conversationId, left);
        }
      }
      if (!this.isWatched()) {
        this.stopTimer();
      }
    };
  }

  /** Pause polling (the app went to the background) or resume it. */
  setActive(isActive: boolean): void {
    if (!isActive) {
      this.stopTimer();
      return;
    }
    if (this.isWatched()) {
      this.startTimer();
      // eslint-disable-next-line no-void -- runs in the background; tick() never rejects
      void this.tick();
    }
  }

  /**
   * Write without signing in (when the app allows guests): `email` is where the team can
   * reach them. The device keeps the guest, and signing in later moves what they wrote
   * to their account.
   */
  async continueAsGuest(input: { email: string; name?: string }): Promise<void> {
    const stored = await this.readStored();
    await this.openGuest({ ...input, ...(stored?.guest !== undefined && { token: stored.guest.token }) });
    await this.refresh();
  }

  /**
   * Let team replies reach this device while the app is closed: pass the Expo push token
   * (`(await Notifications.getExpoPushTokenAsync()).data`). Call again when it changes.
   */
  async registerPushToken(input: MessengerPushTokenRequest): Promise<void> {
    await this.call('POST', '/push-tokens', input);
    this.pushToken = input.token;
    this.pushPlatform = input.platform;
  }

  /**
   * The app's signed-in user changed (they signed in, or switched accounts): ask
   * `identity` again and open their session. What this device wrote as a guest moves to
   * the account, and a registered push token follows the new session.
   */
  async reidentify(): Promise<void> {
    const { pushToken, pushPlatform } = this;
    this.session = null;
    this.pushToken = undefined;
    this.setState({ ...initialState, status: 'loading' });
    await this.refresh();
    if (pushToken !== undefined && pushPlatform !== undefined && this.session !== null) {
      try {
        await this.registerPushToken({ provider: 'expo', token: pushToken, platform: pushPlatform });
      } catch {
        // The app registers again on its next launch.
      }
    }
  }

  /** Forget the session (the user signed out of the app); this device stops getting their pushes. */
  async signOut(): Promise<void> {
    if (this.pushToken !== undefined && this.session !== null) {
      try {
        await this.send('DELETE', '/push-tokens', {
          body: { token: this.pushToken },
          authorization: this.session.token,
        });
      } catch {
        // Signing out must not fail on the network; the token is replaced on the next register.
      }
    }
    this.pushToken = undefined;
    this.pushPlatform = undefined;
    this.session = null;
    await this.writeStored(null);
    this.setState({ ...initialState, status: 'signed_out' });
  }

  /**
   * Erase everything this user wrote: their conversations, messages and screenshots,
   * on Mocco's side and on this device (for the app's "delete my account"). Can't be undone.
   */
  async deleteMyData(): Promise<void> {
    await this.call('DELETE', '/me');
    this.pushToken = undefined;
    this.pushPlatform = undefined;
    this.session = null;
    await this.writeStored(null);
    this.setState({ ...initialState, status: 'signed_out' });
  }

  /** Stop polling for good. */
  close(): void {
    this.stopTimer();
    this.listWatchers = 0;
    this.threadWatchers.clear();
    this.listeners.clear();
  }
}
