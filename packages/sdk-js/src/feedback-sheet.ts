// `@mocco/js/feedback-sheet` (#177): a board's ideas in the page. `createFeedbackSheet` wraps
// the headless `@mocco/sdk-core/feedback-sheet`; `mount` makes a button of the page open a side
// sheet that lists the most voted posts, votes, and posts an idea with the posts like it shown
// first, so users vote instead of posting a duplicate. Plain DOM, no framework, and every text
// goes in as text, so nothing a user writes runs as HTML. Size budget: 25 KB gzipped with
// sdk-core (`yarn sdk:size`).
import { FeedbackSheetModel } from '@mocco/sdk-core/feedback-sheet';

import type { FeedbackPost, FeedbackPostStatus } from '@mocco/sdk-core/feedback';
import type { FeedbackSheetOptions, FeedbackSheetState } from '@mocco/sdk-core/feedback-sheet';

/** The sheet's words, for your language. */
export interface FeedbackSheetLabels {
  /** The heading (default: the board's name). */
  title?: string;
  close: string;
  titlePlaceholder: string;
  bodyPlaceholder: string;
  submit: string;
  posting: string;
  posted: string;
  similar: string;
  top: string;
  vote: string;
  voted: string;
  loading: string;
  empty: string;
  error: string;
  actionError: string;
  signIn: string;
  /** A post's vote count as read by screen readers after the number: "12 votes". */
  votes: (count: number) => string;
  statuses: Record<FeedbackPostStatus, string>;
}

export interface FeedbackSheetMountOptions {
  labels?: Partial<FeedbackSheetLabels>;
  /** Post new ideas in this category of the board (`FeedbackBoard.categories[].id`). */
  categoryId?: string;
  /** Called when the sheet opens or closes, e.g. for analytics. */
  onOpenChange?: (isOpen: boolean) => void;
}

export interface FeedbackSheetWidget {
  /** The headless state underneath (`getState`, `subscribe`, `toggleVote`, `feedback`, …). */
  client: FeedbackSheetModel;
  /**
   * Make `target` (an element or a selector, usually a button) open the sheet. Answers a
   * function that removes it all again.
   */
  mount(target: string | HTMLElement, opts?: FeedbackSheetMountOptions): () => void;
}

const defaultLabels: FeedbackSheetLabels = {
  close: 'Close',
  titlePlaceholder: 'Suggest an idea',
  bodyPlaceholder: 'Add details (optional)',
  submit: 'Post idea',
  posting: 'Posting…',
  posted: 'Thanks! Your idea is posted.',
  similar: 'Already suggested? Vote instead',
  top: 'Top ideas',
  vote: 'Vote',
  voted: 'Voted',
  loading: 'Loading…',
  empty: 'No ideas yet. Be the first.',
  error: "Couldn't load the ideas.",
  actionError: "That didn't go through. Try again.",
  signIn: 'Sign in to vote and post ideas.',
  votes: count => (count === 1 ? '1 vote' : `${count} votes`),
  statuses: {
    under_review: 'Under review',
    planned: 'Planned',
    in_progress: 'In progress',
    shipped: 'Shipped',
    closed: 'Closed',
  },
};

const STYLE_ID = 'mocco-feedback-sheet-style';
const STYLE = `.mocco-fs{position:fixed;z-index:2147483000;top:0;right:0;bottom:0;width:min(400px,100vw);overflow:auto;box-sizing:border-box;padding:16px;border-left:1px solid var(--mocco-fs-border,rgba(0,0,0,.12));background:var(--mocco-fs-bg,#fff);color:var(--mocco-fs-fg,#18181b);box-shadow:-12px 0 32px rgba(0,0,0,.14);font:14px/1.45 system-ui,sans-serif;text-align:left}
.mocco-fs *{box-sizing:border-box}
.mocco-fs[hidden],.mocco-fs [hidden]{display:none}
.mocco-fs-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.mocco-fs h2{margin:0;font-size:16px}
.mocco-fs h3{margin:18px 0 4px;font-size:12px;font-weight:600;opacity:.7}
.mocco-fs input,.mocco-fs textarea{width:100%;padding:9px 11px;border:1px solid var(--mocco-fs-border,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:inherit;font:inherit}
.mocco-fs textarea{margin-top:8px;min-height:72px;resize:vertical}
.mocco-fs button{font:inherit;cursor:pointer}
.mocco-fs button:disabled{cursor:default;opacity:.5}
.mocco-fs-close{border:0;background:none;color:inherit;font-size:20px;line-height:1;padding:4px}
.mocco-fs-submit{width:100%;margin-top:10px;padding:9px;border:0;border-radius:8px;background:var(--mocco-fs-accent,#4f46e5);color:var(--mocco-fs-accent-fg,#fff);font-weight:600}
.mocco-fs-note{margin:8px 0 0;font-size:13px;opacity:.75}
.mocco-fs ul{list-style:none;margin:0;padding:0}
.mocco-fs li{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--mocco-fs-border,rgba(0,0,0,.12))}
.mocco-fs li:first-child{border-top:0}
.mocco-fs-vote{flex:none;width:52px;padding:4px 0;border:1px solid var(--mocco-fs-accent,#4f46e5);border-radius:8px;background:transparent;color:var(--mocco-fs-accent,#4f46e5);text-align:center}
.mocco-fs-vote[aria-pressed=true]{background:var(--mocco-fs-accent,#4f46e5);color:var(--mocco-fs-accent-fg,#fff)}
.mocco-fs-vote b{display:block;font-size:15px}
.mocco-fs-vote span{font-size:11px}
.mocco-fs-status{display:block;font-size:12px;opacity:.65}
.mocco-fs-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-color-scheme:dark){.mocco-fs{border-color:var(--mocco-fs-border,rgba(255,255,255,.14));background:var(--mocco-fs-bg,#1c1c1f);color:var(--mocco-fs-fg,#f4f4f5)}.mocco-fs li,.mocco-fs input,.mocco-fs textarea{border-color:var(--mocco-fs-border,rgba(255,255,255,.14))}}`;

const NOTE = 'mocco-fs-note';

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

/** One post: its vote button (with the count) and its title and status. */
function postItem(post: FeedbackPost, state: FeedbackSheetState, labels: FeedbackSheetLabels): HTMLLIElement {
  const hasVoted = (state.votes[post.id] ?? null) !== null;
  const vote = element('button', 'mocco-fs-vote');
  vote.type = 'button';
  vote.dataset.postId = post.id;
  vote.setAttribute('aria-pressed', String(hasVoted));
  vote.disabled = state.isSignedIn !== true || state.voting.includes(post.id);
  vote.append(
    element('b', undefined, String(post.voteCount)),
    element('span', undefined, hasVoted ? labels.voted : labels.vote),
    element('span', 'mocco-fs-sr', ` (${labels.votes(post.voteCount)})`),
  );
  const text = element('div');
  text.append(element('span', undefined, post.title), element('span', 'mocco-fs-status', labels.statuses[post.status]));
  const item = element('li');
  item.append(vote, text);
  return item;
}

/** The top posts, or why there are none. */
function topContent(state: FeedbackSheetState, labels: FeedbackSheetLabels): HTMLElement {
  if (state.status === 'error') {
    return element('p', NOTE, labels.error);
  }
  if (state.status !== 'ready') {
    return element('p', NOTE, labels.loading);
  }
  if (state.posts.length === 0) {
    return element('p', NOTE, labels.empty);
  }
  const list = element('ul');
  list.append(...state.posts.map(post => postItem(post, state, labels)));
  return list;
}

/** What the note under the post button says, if anything. */
function noteOf(state: FeedbackSheetState, labels: FeedbackSheetLabels): string {
  if (state.actionError !== null) {
    return labels.actionError;
  }
  return state.posted === null ? '' : labels.posted;
}

function mountOn(client: FeedbackSheetModel, targetRef: string | HTMLElement, opts: FeedbackSheetMountOptions) {
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

  // Built once, so typing keeps its focus and caret; only the lists are redrawn.
  const panel = element('div', 'mocco-fs');
  // eslint-disable-next-line sonarjs/pseudo-random -- an element id, not a secret
  panel.id = `mocco-fs-${Math.random().toString(36).slice(2, 10)}`;
  panel.setAttribute('role', 'dialog');
  const heading = element('h2');
  heading.id = `${panel.id}-title`;
  panel.setAttribute('aria-labelledby', heading.id);
  const closeButton = element('button', 'mocco-fs-close', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', labels.close);
  const head = element('div', 'mocco-fs-head');
  head.append(heading, closeButton);
  const signIn = element('p', NOTE, labels.signIn);
  const form = element('form');
  const titleInput = element('input');
  titleInput.placeholder = labels.titlePlaceholder;
  titleInput.setAttribute('aria-label', labels.titlePlaceholder);
  titleInput.maxLength = 200;
  const bodyInput = element('textarea');
  bodyInput.placeholder = labels.bodyPlaceholder;
  bodyInput.setAttribute('aria-label', labels.bodyPlaceholder);
  bodyInput.maxLength = 20_000;
  const similarHeading = element('h3', undefined, labels.similar);
  const similarList = element('ul');
  const submit = element('button', 'mocco-fs-submit');
  submit.type = 'submit';
  const note = element('p', NOTE);
  note.setAttribute('aria-live', 'polite');
  form.append(titleInput, bodyInput, similarHeading, similarList, submit, note);
  const top = element('div');
  panel.append(head, signIn, form, element('h3', undefined, labels.top), top);
  target.setAttribute('aria-haspopup', 'dialog');
  target.setAttribute('aria-expanded', 'false');
  target.setAttribute('aria-controls', panel.id);
  let isOpen = false;

  const render = () => {
    const state = client.getState();
    heading.textContent = labels.title ?? state.board?.name ?? '';
    signIn.hidden = state.isSignedIn !== false;
    form.hidden = state.isSignedIn !== true;
    if (titleInput.value !== state.draft.title) {
      titleInput.value = state.draft.title;
    }
    if (bodyInput.value !== state.draft.body) {
      bodyInput.value = state.draft.body;
    }
    bodyInput.hidden = state.draft.title.trim() === '';
    similarHeading.hidden = state.draft.similar.length === 0;
    // Redrawing a list replaces its buttons: keep the focus on the one that had it.
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focused = active?.dataset.postId;
    const focusedList = active?.closest('ul');
    similarList.replaceChildren(...state.draft.similar.map(post => postItem(post, state, labels)));
    top.replaceChildren(topContent(state, labels));
    if (focused !== undefined) {
      const list = focusedList === similarList ? similarList : top;
      list.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(focused)}"]`)?.focus();
    }
    submit.textContent = state.isPosting ? labels.posting : labels.submit;
    submit.disabled = state.isPosting || state.draft.title.trim() === '';
    note.textContent = noteOf(state, labels);
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

  const open = () => {
    isOpen = true;
    render();
    document.body.append(panel);
    target.setAttribute('aria-expanded', 'true');
    (form.hidden ? closeButton : titleInput).focus();
    opts.onOpenChange?.(true);
    // eslint-disable-next-line no-void -- load() never rejects
    void client.load().then(() => {
      if (isOpen && !form.hidden && !panel.contains(document.activeElement)) {
        titleInput.focus();
      }
    });
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    if (isOpen) {
      close(false);
    } else {
      open();
    }
  };
  const onPanelClick = (event: MouseEvent) => {
    const vote = (event.target as HTMLElement | null)?.closest<HTMLElement>('.mocco-fs-vote');
    const postId = vote?.dataset.postId;
    if (postId !== undefined) {
      // eslint-disable-next-line no-void -- toggleVote() never rejects
      void client.toggleVote(postId);
    }
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    // eslint-disable-next-line no-void -- submit() never rejects
    void client.submit(opts.categoryId === undefined ? {} : { categoryId: opts.categoryId });
  };
  const onTitle = () => {
    client.setDraft({ title: titleInput.value });
  };
  const onBody = () => {
    client.setDraft({ body: bodyInput.value });
  };
  const onCloseClick = () => {
    close(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close(true);
    }
  };

  const unsubscribe = client.subscribe(() => {
    if (isOpen) {
      render();
    }
  });
  target.addEventListener('click', onClick);
  panel.addEventListener('click', onPanelClick);
  form.addEventListener('submit', onSubmit);
  titleInput.addEventListener('input', onTitle);
  bodyInput.addEventListener('input', onBody);
  closeButton.addEventListener('click', onCloseClick);
  document.addEventListener('keydown', onKeyDown);

  return () => {
    close(false);
    unsubscribe();
    client.dispose();
    target.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeyDown);
    target.removeAttribute('aria-haspopup');
    target.removeAttribute('aria-expanded');
    target.removeAttribute('aria-controls');
  };
}

/**
 * A board's feedback sheet for the page. Pass `endUserToken` (a function that fetches the
 * token your server signs) so signed-in users can vote and post; without one the sheet is
 * read-only. Create it once.
 */
export function createFeedbackSheet(options: FeedbackSheetOptions): FeedbackSheetWidget {
  const client = new FeedbackSheetModel(options);
  return { client, mount: (target, opts = {}) => mountOn(client, target, opts) };
}

export { FeedbackSheetModel } from '@mocco/sdk-core/feedback-sheet';
export type { FeedbackSheetDraft, FeedbackSheetOptions, FeedbackSheetState } from '@mocco/sdk-core/feedback-sheet';
export type { FeedbackPost, FeedbackPostStatus } from '@mocco/sdk-core/feedback';
