// `@mocco/js/whats-new` (#177): a board's changelog in the page. `createWhatsNew` gives the
// unread count and "mark seen" over `@mocco/sdk-core/whats-new`; `mount` puts a badge on a
// button of the page and opens the newest entries in a small popover. Plain DOM, no framework,
// and every text goes in as text (an entry's Markdown is shown as a plain excerpt), so nothing
// the team writes runs as HTML. Size budget: 25 KB gzipped with sdk-core (`yarn sdk:size`).
import { WhatsNew } from '@mocco/sdk-core/whats-new';

import type { FeedbackChangelogEntry } from '@mocco/sdk-core/feedback';
import type { WhatsNewOptions, WhatsNewState, WhatsNewStorage } from '@mocco/sdk-core/whats-new';

export interface WhatsNewWebOptions extends Omit<WhatsNewOptions, 'storage'> {
  /** Where a visitor's "last looked" date is kept: localStorage by default, null for memory only. */
  storage?: WhatsNewStorage | null;
}

/** The widget's words, for your language. */
export interface WhatsNewLabels {
  title: string;
  loading: string;
  empty: string;
  error: string;
  /** The link under the list (with `moreUrl`). */
  more: string;
  /** Read by screen readers after the number: "(3 unread updates)". */
  unread: string;
}

export interface WhatsNewMountOptions {
  labels?: Partial<WhatsNewLabels>;
  /** A link under the list, such as the board's public changelog page. */
  moreUrl?: string;
  /** Mark every entry seen when the popover opens (default true). */
  markSeenOnOpen?: boolean;
  /** An entry's date as shown (default: the browser's locale, e.g. "Oct 17, 2026"). */
  formatDate?: (iso: string) => string;
  /** Called when the popover opens or closes, e.g. for analytics. */
  onOpenChange?: (isOpen: boolean) => void;
}

export interface WhatsNewWidget {
  /** The headless state underneath (`getState`, `subscribe`, `loadEntries`, `feedback`). */
  client: WhatsNew;
  /** Entries published since the user last looked (up to 100), fetched now. */
  unreadCount(): Promise<number>;
  /** The user has seen every entry. */
  markSeen(): Promise<void>;
  /**
   * Put an unread badge on `target` (an element or a selector, usually a button) that opens
   * the newest entries in a popover. Answers a function that removes it all again.
   */
  mount(target: string | HTMLElement, opts?: WhatsNewMountOptions): () => void;
}

const defaultLabels: WhatsNewLabels = {
  title: "What's new",
  loading: 'Loading…',
  empty: 'Nothing new yet.',
  error: "Couldn't load the latest updates.",
  more: 'See all updates',
  unread: 'unread updates',
};

const STYLE_ID = 'mocco-whats-new-style';
const STYLE = `.mocco-wn-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:9px;box-sizing:border-box;background:var(--mocco-wn-accent,#e5484d);color:var(--mocco-wn-accent-fg,#fff);font:600 11px/1 system-ui,sans-serif}
.mocco-wn-badge[hidden]{display:none}
.mocco-wn-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mocco-wn-panel{position:fixed;z-index:2147483000;width:min(360px,calc(100vw - 16px));max-height:min(480px,calc(100vh - 16px));overflow:auto;box-sizing:border-box;padding:16px;border-radius:12px;border:1px solid var(--mocco-wn-border,rgba(0,0,0,.12));background:var(--mocco-wn-bg,#fff);color:var(--mocco-wn-fg,#18181b);box-shadow:0 12px 32px rgba(0,0,0,.18);font:14px/1.45 system-ui,sans-serif;text-align:left}
.mocco-wn-panel:focus{outline:none}
.mocco-wn-panel h2{margin:0 0 4px;font-size:15px}
.mocco-wn-panel ul{list-style:none;margin:0;padding:0}
.mocco-wn-panel li{padding:12px 0;border-top:1px solid var(--mocco-wn-border,rgba(0,0,0,.12))}
.mocco-wn-panel li:first-child{border-top:0}
.mocco-wn-panel h3{margin:0;font-size:14px}
.mocco-wn-panel p{margin:4px 0 0}
.mocco-wn-meta{font-size:12px;opacity:.7}
.mocco-wn-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;background:var(--mocco-wn-tag,rgba(0,0,0,.06))}
.mocco-wn-panel a{display:block;margin-top:8px;color:inherit}
@media (prefers-color-scheme:dark){.mocco-wn-panel{border-color:var(--mocco-wn-border,rgba(255,255,255,.14));background:var(--mocco-wn-bg,#1c1c1f);color:var(--mocco-wn-fg,#f4f4f5)}.mocco-wn-tag{background:var(--mocco-wn-tag,rgba(255,255,255,.1))}}`;

/** The page's localStorage. A blocked one throws, and the client then keeps the date in memory. */
const localStorageOf = () => Reflect.get(globalThis, 'localStorage') as WhatsNewStorage;
const browserStorage: WhatsNewStorage = {
  getItem: async key => await localStorageOf().getItem(key),
  setItem: async (key, value) => {
    await localStorageOf().setItem(key, value);
  },
};

/**
 * An entry's Markdown as a short plain-text excerpt: links and images become their text, code
 * fences and markup characters go.
 */
export function excerptOf(markdown: string, max = 240): string {
  /* eslint-disable sonarjs/null-dereference -- strings all the way, never null */
  const text = markdown
    .split('\n')
    .filter(line => !line.trimStart().startsWith('```'))
    .join(' ')
    .replaceAll(/\]\([^)]*\)/g, ']')
    .replaceAll('![', '[')
    .replaceAll(/[[\]#>*_`~]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  /* eslint-enable sonarjs/null-dereference */
}

const defaultFormatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function entryItem(entry: FeedbackChangelogEntry, formatDate: (iso: string) => string): HTMLLIElement {
  const item = element('li');
  item.append(element('h3', undefined, entry.title));
  const meta = element('div', 'mocco-wn-meta', formatDate(entry.publishedAt));
  // eslint-disable-next-line no-restricted-syntax -- at most three tags
  for (const tag of entry.tags) {
    meta.append(element('span', 'mocco-wn-tag', tag));
  }
  item.append(meta);
  const excerpt = excerptOf(entry.body);
  if (excerpt !== '') {
    item.append(element('p', undefined, excerpt));
  }
  return item;
}

/** The popover's content for `state`. */
function panelContent(state: WhatsNewState, labels: WhatsNewLabels, opts: WhatsNewMountOptions): HTMLElement[] {
  const nodes: HTMLElement[] = [element('h2', undefined, labels.title)];
  if (state.entries.length > 0) {
    const list = element('ul');
    list.append(...state.entries.map(entry => entryItem(entry, opts.formatDate ?? defaultFormatDate)));
    nodes.push(list);
  } else if (state.status === 'error') {
    nodes.push(element('p', undefined, labels.error));
  } else {
    nodes.push(element('p', undefined, state.status === 'ready' ? labels.empty : labels.loading));
  }
  if (opts.moreUrl !== undefined) {
    const more = element('a', undefined, labels.more);
    more.href = opts.moreUrl;
    nodes.push(more);
  }
  return nodes;
}

function mountOn(client: WhatsNew, targetRef: string | HTMLElement, opts: WhatsNewMountOptions): () => void {
  const target = typeof targetRef === 'string' ? document.querySelector<HTMLElement>(targetRef) : targetRef;
  if (target === null) {
    throw new Error(`No element matches ${String(targetRef)}`);
  }
  if (document.querySelector(`#${STYLE_ID}`) === null) {
    const style = element('style', undefined, STYLE);
    style.id = STYLE_ID;
    document.head.append(style);
  }
  const labels = { ...defaultLabels, ...opts.labels };
  const badge = element('span', 'mocco-wn-badge');
  target.append(badge);
  const panel = element('div', 'mocco-wn-panel');
  // eslint-disable-next-line sonarjs/pseudo-random -- an element id, not a secret
  panel.id = `mocco-wn-${Math.random().toString(36).slice(2, 10)}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', labels.title);
  panel.tabIndex = -1;
  target.setAttribute('aria-haspopup', 'dialog');
  target.setAttribute('aria-expanded', 'false');
  target.setAttribute('aria-controls', panel.id);
  let isOpen = false;

  const render = () => {
    const state = client.getState();
    badge.hidden = state.unreadCount === 0;
    const count = state.unreadCount > 99 ? '99+' : String(state.unreadCount);
    const shown = element('span', undefined, count);
    shown.setAttribute('aria-hidden', 'true');
    badge.replaceChildren(shown, element('span', 'mocco-wn-sr', ` (${count} ${labels.unread})`));
    if (isOpen) {
      panel.replaceChildren(...panelContent(state, labels, opts));
    }
  };

  const place = () => {
    const rect = target.getBoundingClientRect();
    const width = panel.offsetWidth;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    panel.style.left = `${Math.round(Math.max(8, left))}px`;
  };

  const close = (shouldReturnFocus: boolean) => {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    panel.remove();
    target.setAttribute('aria-expanded', 'false');
    if (shouldReturnFocus) {
      target.focus();
    }
    opts.onOpenChange?.(false);
  };

  const open = async () => {
    isOpen = true;
    render();
    document.body.append(panel);
    place();
    target.setAttribute('aria-expanded', 'true');
    panel.focus();
    opts.onOpenChange?.(true);
    try {
      await client.loadEntries();
      if (opts.markSeenOnOpen ?? true) {
        await client.markSeen();
      }
    } catch {
      // The popover shows the error from the state.
    }
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    if (isOpen) {
      close(false);
    } else {
      // eslint-disable-next-line no-void -- open() handles its own failures
      void open();
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close(true);
    }
  };
  // A resized window would leave the popover beside its button: close it instead.
  const onResize = () => {
    close(false);
  };
  const onPointerDown = (event: PointerEvent) => {
    const node = event.target as Node | null;
    if (node !== null && !panel.contains(node) && !target.contains(node)) {
      close(false);
    }
  };

  const unsubscribe = client.subscribe(render);
  target.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', onResize);
  render();
  // eslint-disable-next-line no-void -- refresh() never rejects
  void client.refresh();

  return () => {
    close(false);
    unsubscribe();
    target.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('resize', onResize);
    badge.remove();
    target.removeAttribute('aria-haspopup');
    target.removeAttribute('aria-expanded');
    target.removeAttribute('aria-controls');
  };
}

/**
 * A board's "what's new" for the page. Signed in (`endUserToken`), the read mark is the end
 * user's own on Mocco; anonymous, it is kept in localStorage. Create it once.
 */
export function createWhatsNew(options: WhatsNewWebOptions): WhatsNewWidget {
  const { storage, ...rest } = options;
  const resolved = storage === undefined ? browserStorage : storage;
  const client = new WhatsNew({ ...rest, ...(resolved !== null && { storage: resolved }) });
  return {
    client,
    unreadCount: async () => await client.unreadCount(),
    markSeen: async () => {
      await client.markSeen();
    },
    mount: (target, opts = {}) => mountOn(client, target, opts),
  };
}

export { WhatsNew } from '@mocco/sdk-core/whats-new';
export type { WhatsNewState, WhatsNewStorage } from '@mocco/sdk-core/whats-new';
export type { FeedbackChangelogEntry, FeedbackChangelogTag } from '@mocco/sdk-core/feedback';
