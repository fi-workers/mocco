// A feedback sheet's state, headless (#177): a board's top posts with the end user's votes, and
// an idea being written, with the posts like it so the user can vote instead of posting a
// duplicate. The web sheet (`@mocco/js/feedback-sheet`) and the React Native `FeedbackSheet`
// (`@mocco/react-native/feedback`) draw it. A subpath of its own
// (`@mocco/sdk-core/feedback-sheet`); it imports the feedback client by name, so the built
// files share one `FeedbackClient` and `MoccoError`.
import { FeedbackClient } from '@mocco/sdk-core/feedback';

import type {
  FeedbackBoard,
  FeedbackBoardClient,
  FeedbackClientOptions,
  FeedbackPost,
  FeedbackVoteResult,
  FeedbackVoteState,
} from '@mocco/sdk-core/feedback';

export interface FeedbackSheetOptions extends FeedbackClientOptions {
  /** The board to show and post to (its slug). */
  board: string;
  /** How many of the board's top posts to list (1–100, default 20). */
  pageSize?: number;
  /** How long typing pauses before the similar posts are searched, in ms (default 300). */
  similarDelayMs?: number;
  /** The shortest title that searches for similar posts (default 3 characters). */
  similarMinLength?: number;
}

/** The idea being written. */
export interface FeedbackSheetDraft {
  title: string;
  body: string;
  /** Posts like the title, to vote for instead (empty while the title is short). */
  similar: FeedbackPost[];
  isSearching: boolean;
}

export interface FeedbackSheetState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The board's name and categories, once loaded. */
  board: FeedbackBoard | null;
  /** The board's most voted posts. */
  posts: FeedbackPost[];
  /**
   * Whether `endUserToken` gave a token, so the user can vote and post (null before `load`).
   * Signed out, the sheet is read-only.
   */
  isSignedIn: boolean | null;
  /**
   * The end user's votes by post id: from the board's list and the similar posts (Mocco says
   * which of them the signed-in user voted for, here or anywhere else), then their votes and
   * posts here.
   */
  votes: Record<string, FeedbackVoteState | null>;
  /** Posts whose vote is on its way. */
  voting: string[];
  draft: FeedbackSheetDraft;
  isPosting: boolean;
  /** The post the user just created, until they start another. */
  posted: FeedbackPost | null;
  /** Why the board couldn't be loaded. */
  error: Error | null;
  /** Why the last vote or post failed. */
  actionError: Error | null;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SIMILAR_DELAY_MS = 300;
const DEFAULT_SIMILAR_MIN_LENGTH = 3;

const emptyDraft: FeedbackSheetDraft = { title: '', body: '', similar: [], isSearching: false };

const initialState: FeedbackSheetState = {
  status: 'idle',
  board: null,
  posts: [],
  isSignedIn: null,
  votes: {},
  voting: [],
  draft: emptyDraft,
  isPosting: false,
  posted: null,
  error: null,
  actionError: null,
};

const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

/** The viewer's votes the answer's posts carry (absent for a visitor). */
const viewerVotesOf = (posts: FeedbackPost[]): Record<string, FeedbackVoteState | null> =>
  Object.fromEntries(posts.flatMap(post => (post.viewerVote === undefined ? [] : [[post.id, post.viewerVote]])));

/** `posts` with `postId`'s count set from a vote's answer. */
const withCount = (posts: FeedbackPost[], postId: string, voteCount: number): FeedbackPost[] =>
  posts.map(post => (post.id === postId ? { ...post, voteCount } : post));

/**
 * One board's feedback sheet. Create it once; `subscribe` and `getState` fit
 * `useSyncExternalStore`. Every action resolves (a failure lands in `error` or `actionError`),
 * so a UI can call them without handling rejections.
 */
export class FeedbackSheetModel {
  private state: FeedbackSheetState = initialState;

  private readonly listeners = new Set<() => void>();

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** Bumped by every title change, so an older search's answer is dropped. */
  private searchSeq = 0;

  readonly feedback: FeedbackClient;

  readonly board: FeedbackBoardClient;

  getState = (): FeedbackSheetState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  constructor(private readonly options: FeedbackSheetOptions) {
    this.feedback = new FeedbackClient(options);
    this.board = this.feedback.board(options.board);
  }

  private setState(patch: Partial<FeedbackSheetState>): void {
    this.state = { ...this.state, ...patch };
    // eslint-disable-next-line no-restricted-syntax -- listeners run for their side effects
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setDraftState(patch: Partial<FeedbackSheetDraft>): void {
    this.setState({ draft: { ...this.state.draft, ...patch } });
  }

  /** Whether a user is signed in: a token source that fails counts as signed out. */
  private async hasEndUser(): Promise<boolean> {
    try {
      return (await this.feedback.endUserToken()) !== null;
    } catch {
      return false;
    }
  }

  private applyVote(postId: string, result: FeedbackVoteResult): void {
    const { draft } = this.state;
    this.setState({
      posts: withCount(this.state.posts, postId, result.voteCount),
      draft: { ...draft, similar: withCount(draft.similar, postId, result.voteCount) },
      votes: { ...this.state.votes, [postId]: result.vote },
    });
  }

  private scheduleSearch(query: string): void {
    clearTimeout(this.searchTimer);
    this.searchSeq += 1;
    // eslint-disable-next-line sonarjs/null-dereference -- query is a string, never null
    if (query.length < (this.options.similarMinLength ?? DEFAULT_SIMILAR_MIN_LENGTH)) {
      this.setDraftState({ similar: [], isSearching: false });
      return;
    }
    const seq = this.searchSeq;
    this.setDraftState({ isSearching: true });
    this.searchTimer = setTimeout(() => {
      // eslint-disable-next-line no-void -- a timer callback can't await; search() never rejects
      void this.search(query, seq);
    }, this.options.similarDelayMs ?? DEFAULT_SIMILAR_DELAY_MS);
  }

  /** Take the viewer's votes from an answer, except on posts whose vote is on its way. */
  private votesWith(posts: FeedbackPost[]): Record<string, FeedbackVoteState | null> {
    const { voting } = this.state;
    const known = Object.entries(viewerVotesOf(posts)).filter(([postId]) => !voting.includes(postId));
    return { ...this.state.votes, ...Object.fromEntries(known) };
  }

  private async search(query: string, seq: number): Promise<void> {
    try {
      const similar = await this.board.similar(query);
      if (seq === this.searchSeq) {
        this.setState({
          draft: { ...this.state.draft, similar, isSearching: false },
          votes: this.votesWith(similar),
        });
      }
    } catch {
      // Offline or limited: keep the last suggestions.
      if (seq === this.searchSeq) {
        this.setDraftState({ isSearching: false });
      }
    }
  }

  /** The board and its top posts, and whether a user is signed in. Run it when the sheet opens. */
  async load(): Promise<void> {
    this.setState({ status: 'loading', error: null });
    try {
      const [board, page, isSignedIn] = await Promise.all([
        this.board.get(),
        this.board.posts({ sort: 'top', limit: this.options.pageSize ?? DEFAULT_PAGE_SIZE }),
        this.hasEndUser(),
      ]);
      this.setState({ status: 'ready', board, posts: page.posts, isSignedIn, votes: this.votesWith(page.posts) });
    } catch (error) {
      this.setState({ status: 'error', error: errorOf(error) });
    }
  }

  /** Vote for a post, or take the vote back when the user has voted for it here. */
  async toggleVote(postId: string): Promise<void> {
    if (this.state.voting.includes(postId)) {
      return;
    }
    const hasVoted = (this.state.votes[postId] ?? null) !== null;
    this.setState({ voting: [...this.state.voting, postId], actionError: null });
    try {
      const result = hasVoted ? await this.feedback.unvote(postId) : await this.feedback.vote(postId);
      this.applyVote(postId, result);
    } catch (error) {
      this.setState({ actionError: errorOf(error) });
    } finally {
      this.setState({ voting: this.state.voting.filter(id => id !== postId) });
    }
  }

  /** Change the idea being written; a new title searches for similar posts once typing pauses. */
  setDraft(patch: { title?: string; body?: string }): void {
    const { title } = patch;
    if (title === undefined || title === this.state.draft.title) {
      this.setDraftState(patch);
      return;
    }
    this.setState({ draft: { ...this.state.draft, ...patch }, posted: null, actionError: null });
    this.scheduleSearch(title.trim());
  }

  /**
   * Post the draft as the signed-in user's idea: it starts under review with their vote, goes
   * to the top of the list, and the draft clears. Answers the post, or null when it wasn't
   * posted (an empty title, or a failure in `actionError`).
   */
  async submit(opts: { categoryId?: string } = {}): Promise<FeedbackPost | null> {
    const title = this.state.draft.title.trim();
    if (title === '' || this.state.isPosting) {
      return null;
    }
    const body = this.state.draft.body.trim();
    this.setState({ isPosting: true, actionError: null });
    try {
      const post = await this.board.createPost({
        title,
        ...(body !== '' && { body }),
        ...(opts.categoryId !== undefined && { categoryId: opts.categoryId }),
      });
      this.dispose();
      this.setState({
        isPosting: false,
        posts: [post, ...this.state.posts.filter(existing => existing.id !== post.id)],
        votes: { ...this.state.votes, [post.id]: 'counted' },
        draft: emptyDraft,
        posted: post,
      });
      return post;
    } catch (error) {
      this.setState({ isPosting: false, actionError: errorOf(error) });
      return null;
    }
  }

  /** Stop a pending similar-posts search, e.g. when the sheet closes for good. */
  dispose(): void {
    clearTimeout(this.searchTimer);
    this.searchSeq += 1;
  }
}
