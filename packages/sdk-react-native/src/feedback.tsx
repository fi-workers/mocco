// The `@mocco/react-native/feedback` entry (#177): a board's ideas in the app. Create one sheet
// with `createFeedbackSheet` (outside a component); `<FeedbackSheet />` opens it as a modal
// sheet that lists the most voted posts, votes, and posts an idea with the posts like it shown
// first, so users vote instead of posting a duplicate. `useFeedbackSheet` gives the same state
// to an app that draws its own screen. Pure JS, so it runs in Expo Go.
import { FeedbackSheetModel } from '@mocco/sdk-core/feedback-sheet';
import { useEffect, useSyncExternalStore } from 'react';
// eslint-disable-next-line import-x/no-unresolved -- a peer dependency the app installs
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { FeedbackPost, FeedbackPostStatus } from '@mocco/sdk-core/feedback';
import type { FeedbackSheetOptions, FeedbackSheetState } from '@mocco/sdk-core/feedback-sheet';

export type {
  EndUserTokenSource,
  FeedbackBoard,
  FeedbackCategory,
  FeedbackComment,
  FeedbackCommentPage,
  FeedbackPost,
  FeedbackPostCreateRequest,
  FeedbackPostStatus,
  FeedbackRoadmap,
  FeedbackSubscription,
  FeedbackVoteResult,
  FeedbackVoteState,
} from '@mocco/sdk-core/feedback';
export type { FeedbackSheetDraft, FeedbackSheetOptions, FeedbackSheetState } from '@mocco/sdk-core/feedback-sheet';
export { FeedbackClient } from '@mocco/sdk-core/feedback';
export { FeedbackSheetModel } from '@mocco/sdk-core/feedback-sheet';

/**
 * One board's feedback sheet for the app; create it once. Pass `endUserToken` (a function that
 * fetches the token your server signs) so signed-in users can vote and post; without one the
 * sheet is read-only.
 */
export function createFeedbackSheet(options: FeedbackSheetOptions): FeedbackSheetModel {
  return new FeedbackSheetModel(options);
}

/**
 * The sheet's state, re-rendering when it changes, and its actions. Loads the board on mount
 * (pass `load: false` to call `load()` yourself).
 */
export function useFeedbackSheet(
  sheet: FeedbackSheetModel,
  opts: { load?: boolean } = {},
): FeedbackSheetState & {
  load: () => Promise<void>;
  toggleVote: (postId: string) => Promise<void>;
  setDraft: (patch: { title?: string; body?: string }) => void;
  submit: (opts?: { categoryId?: string }) => Promise<FeedbackPost | null>;
} {
  const state = useSyncExternalStore(sheet.subscribe, sheet.getState, sheet.getState);
  const shouldLoad = opts.load ?? true;
  useEffect(() => {
    if (shouldLoad) {
      // eslint-disable-next-line no-void -- load() never rejects
      void sheet.load();
    }
  }, [sheet, shouldLoad]);
  return {
    ...state,
    load: sheet.load.bind(sheet),
    toggleVote: sheet.toggleVote.bind(sheet),
    setDraft: sheet.setDraft.bind(sheet),
    submit: sheet.submit.bind(sheet),
  };
}

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
  /** A post's vote count as read by screen readers. */
  votes: (count: number) => string;
  statuses: Record<FeedbackPostStatus, string>;
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

const ink = '#18181b';
const muted = '#71717a';
const line = '#e4e4e7';

const styles = {
  sheet: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: line,
  },
  heading: { fontSize: 17, fontWeight: '600', color: ink },
  content: { padding: 16, paddingBottom: 48 },
  input: {
    borderWidth: 1,
    borderColor: line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: ink,
  },
  body: { marginTop: 8, minHeight: 72, textAlignVertical: 'top' },
  button: { marginTop: 10, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  note: { marginTop: 8, fontSize: 13, color: muted },
  section: { marginTop: 20, marginBottom: 4, fontSize: 13, fontWeight: '600', color: muted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: line,
  },
  vote: {
    width: 56,
    marginRight: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
  },
  count: { fontSize: 15, fontWeight: '600' },
  voteText: { fontSize: 11 },
  postTitle: { fontSize: 15, color: ink },
  status: { marginTop: 2, fontSize: 12, color: muted },
} as const;

function PostRow({
  post,
  state,
  labels,
  accentColor,
  onVote,
}: {
  post: FeedbackPost;
  state: FeedbackSheetState;
  labels: FeedbackSheetLabels;
  accentColor: string;
  onVote: (postId: string) => void;
}) {
  const hasVoted = (state.votes[post.id] ?? null) !== null;
  const isBusy = state.voting.includes(post.id);
  const isDisabled = state.isSignedIn !== true || isBusy;
  const color = hasVoted ? '#fff' : accentColor;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${hasVoted ? labels.voted : labels.vote}, ${labels.votes(post.voteCount)}`}
        accessibilityState={{ disabled: isDisabled, selected: hasVoted, busy: isBusy }}
        disabled={isDisabled}
        onPress={() => {
          onVote(post.id);
        }}
        style={[
          styles.vote,
          { borderColor: accentColor, backgroundColor: hasVoted ? accentColor : 'transparent' },
          isDisabled && !isBusy && { opacity: 0.5 },
        ]}>
        <Text style={[styles.count, { color }]}>{post.voteCount}</Text>
        <Text style={[styles.voteText, { color }]}>{hasVoted ? labels.voted : labels.vote}</Text>
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.postTitle} numberOfLines={2}>
          {post.title}
        </Text>
        <Text style={styles.status}>{labels.statuses[post.status]}</Text>
      </View>
    </View>
  );
}

/** The list under the form: the board's top posts, or why there are none. */
function TopPosts({
  state,
  labels,
  accentColor,
  onVote,
}: {
  state: FeedbackSheetState;
  labels: FeedbackSheetLabels;
  accentColor: string;
  onVote: (postId: string) => void;
}) {
  if (state.status === 'error') {
    return <Text style={styles.note}>{labels.error}</Text>;
  }
  if (state.status !== 'ready') {
    return <ActivityIndicator color={accentColor} style={{ marginTop: 16 }} />;
  }
  if (state.posts.length === 0) {
    return <Text style={styles.note}>{labels.empty}</Text>;
  }
  return (
    <View>
      {state.posts.map(post => (
        <PostRow key={post.id} post={post} state={state} labels={labels} accentColor={accentColor} onVote={onVote} />
      ))}
    </View>
  );
}

/**
 * A modal sheet with the board's top ideas and a box to post one. While the user types a
 * title, posts like it show above the button, so they can vote for one instead. Signed out
 * (no `endUserToken`, or it returns null), it lists the ideas and says `labels.signIn`.
 */
export function FeedbackSheet({
  sheet,
  visible,
  onClose,
  labels: labelOverrides,
  accentColor = '#4f46e5',
  categoryId,
}: {
  sheet: FeedbackSheetModel;
  visible: boolean;
  onClose: () => void;
  labels?: Partial<FeedbackSheetLabels>;
  /** The vote buttons and the post button (default indigo). */
  accentColor?: string;
  /** Post new ideas in this category of the board. */
  categoryId?: string;
}) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const state = useFeedbackSheet(sheet, { load: false });
  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line no-void -- load() never rejects
      void sheet.load();
    }
  }, [sheet, visible]);
  const onVote = (postId: string) => {
    // eslint-disable-next-line no-void -- toggleVote() never rejects
    void sheet.toggleVote(postId);
  };
  const canPost = state.isSignedIn === true && state.draft.title.trim() !== '' && !state.isPosting;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.heading} accessibilityRole="header">
            {labels.title ?? state.board?.name ?? ''}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onClose}>
            <Text style={{ fontSize: 15, color: accentColor }}>{labels.close}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {state.isSignedIn === false && <Text style={[styles.note, { marginTop: 0 }]}>{labels.signIn}</Text>}
          {state.isSignedIn === true && (
            <View>
              <TextInput
                style={styles.input}
                value={state.draft.title}
                onChangeText={title => {
                  sheet.setDraft({ title });
                }}
                placeholder={labels.titlePlaceholder}
                placeholderTextColor={muted}
                maxLength={200}
                accessibilityLabel={labels.titlePlaceholder}
              />
              {state.draft.title.trim() !== '' && (
                <TextInput
                  style={[styles.input, styles.body]}
                  value={state.draft.body}
                  onChangeText={body => {
                    sheet.setDraft({ body });
                  }}
                  placeholder={labels.bodyPlaceholder}
                  placeholderTextColor={muted}
                  multiline
                  maxLength={20_000}
                  accessibilityLabel={labels.bodyPlaceholder}
                />
              )}
              {state.draft.similar.length > 0 && (
                <View>
                  <Text style={styles.section}>{labels.similar}</Text>
                  {state.draft.similar.map(post => (
                    <PostRow
                      key={post.id}
                      post={post}
                      state={state}
                      labels={labels}
                      accentColor={accentColor}
                      onVote={onVote}
                    />
                  ))}
                </View>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canPost, busy: state.isPosting }}
                disabled={!canPost}
                onPress={() => {
                  // eslint-disable-next-line no-void -- submit() never rejects
                  void sheet.submit(categoryId === undefined ? {} : { categoryId });
                }}
                style={[styles.button, { backgroundColor: accentColor, opacity: canPost ? 1 : 0.5 }]}>
                <Text style={styles.buttonText}>{state.isPosting ? labels.posting : labels.submit}</Text>
              </Pressable>
              {state.posted !== null && <Text style={styles.note}>{labels.posted}</Text>}
            </View>
          )}
          {state.actionError !== null && <Text style={[styles.note, { color: '#e5484d' }]}>{labels.actionError}</Text>}
          <Text style={styles.section}>{labels.top}</Text>
          <TopPosts state={state} labels={labels} accentColor={accentColor} onVote={onVote} />
        </ScrollView>
      </View>
    </Modal>
  );
}
