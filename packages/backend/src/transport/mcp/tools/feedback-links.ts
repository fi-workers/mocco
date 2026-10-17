// `mocco_feedback_*` for a post's GitHub links (#178): which issues and pull requests a post links,
// with their state, merge commit and an issue's closing pull requests; a search of the project's
// repos for one to link; and, as changes, linking one to a post and removing a link.
//
// Thin adapters (ADR 0025) over `LinkService`, the service the console's `feedback` router calls
// for the same answers and changes (`linkRepos`, `linkSearch`, `links`, `link`, `unlink`), after
// `ProjectScope` has checked the caller's workspace, project and `Products.feedback`. The service
// asks GitHub only about repos linked to the post's project, so another tenant's repo, post or
// link reads exactly like one that does not exist.
//
// The two changes have the locks of every changing tool (`openDecision`, `confirmThenApply`):
// `feedback:write`, the workspace's opt-in, and a confirmation naming the post, the repo and the
// issue or pull request with its state. Each confirmation is bound to what it showed: a link to
// the target's state when asked, an unlink to the link's state, so an answer given after GitHub
// says something else asks again. A merged post, a repo the project doesn't link, a number the
// repo doesn't have and a target the post links already are refused before asking.
import {
  FEEDBACK_LINK_SEARCH_LIMIT,
  FeedbackLinkKinds,
  feedbackLinkCreateInputSchema,
  feedbackLinkKindSchema,
} from '@mocco/common/feedback';
import { McpScopes } from '@mocco/common/mcp';
import { z } from 'zod';

import { FeedbackLinkRepoNotFoundError } from '@backend/domain/feedback/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import {
  FEEDBACK_WRITE_ALLOWS,
  feedbackRefusal,
  postArg,
  postLabel,
  projectArg,
  resolveFeedbackProject,
  responseFormatArg,
} from '@backend/transport/mcp/tools/feedback';
import { asJson, userIdOf, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { LinkService } from '@backend/domain/feedback/LinkService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { FeedbackLinkKind } from '@mocco/common/feedback';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface FeedbackLinkToolDeps extends DecidingToolDeps {
  feedbackPosts: Pick<PostService, 'requirePost'>;
  feedbackLinks: Pick<LinkService, 'repos' | 'search' | 'list' | 'preview' | 'requireLink' | 'link' | 'unlink'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const FEEDBACK_LINK_TOOL = 'mocco_feedback_post_link';
export const FEEDBACK_UNLINK_TOOL = 'mocco_feedback_post_unlink';

const kindArg = feedbackLinkKindSchema.describe('`issue` or `pull_request`.');

const linksInput = z.object({
  postId: postArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
  responseFormat: responseFormatArg(
    "each link's id, repo (owner/name), kind, number, title, state (`open`, `closed`, or `merged` for a pull request), merge commit, and an issue's closing pull requests (number, title, state, merge commit)",
    'adds the links and closers on GitHub, the repo id, when each merged, when GitHub last told Mocco about it, and who linked it (a user id)',
  ),
});

const searchInput = z.object({
  query: z
    .string()
    .trim()
    .max(200)
    .describe('Words in the title or body, or a number (`12` or `#12`) for that one issue or pull request.'),
  kind: kindArg,
  repoId: z
    .uuid()
    .optional()
    .describe("One of the project's repos, as an answer names it. Omit it to search every repo the project links."),
  workspaceId: workspaceArg,
  projectId: projectArg,
  limit: z
    .number()
    .int()
    .min(1)
    .max(FEEDBACK_LINK_SEARCH_LIMIT)
    .default(FEEDBACK_LINK_SEARCH_LIMIT)
    .describe('The most results per repo.'),
  responseFormat: responseFormatArg(
    "each result's repo id and name, kind, number, title and state",
    'adds its address on GitHub',
  ),
});

const linkInput = z.object({
  postId: postArg,
  repoId: feedbackLinkCreateInputSchema.shape.repoId.describe(
    "The repo, as `mocco_feedback_github_search` names it: one the post's project links.",
  ),
  kind: kindArg,
  number: feedbackLinkCreateInputSchema.shape.number.describe('The issue or pull request number.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const unlinkInput = z.object({
  linkId: z.uuid().describe('The link, as `mocco_feedback_links_list` names it.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type ListLinksArgs = z.infer<typeof linksInput>;
export type SearchGithubArgs = z.infer<typeof searchInput>;
export type LinkArgs = z.infer<typeof linkInput>;
export type UnlinkArgs = z.infer<typeof unlinkInput>;

const repoName = (repo: { owner: string; name: string } | null) =>
  repo === null ? null : `${repo.owner}/${repo.name}`;

/** "issue #12" or "pull request #34". */
const targetLabel = (kind: FeedbackLinkKind, number: number) =>
  `${kind === FeedbackLinkKinds.issue ? 'issue' : 'pull request'} #${String(number)}`;

export async function listLinks(deps: FeedbackLinkToolDeps, args: ListLinksArgs, userId: string) {
  const scope = await resolveFeedbackProject(deps, userId, args);
  const links = await deps.feedbackLinks.list(scope, args.postId);
  const isDetailed = args.responseFormat === 'detailed';
  return {
    postId: args.postId,
    links: links.map(link => ({
      id: link.id,
      repo: repoName(link.repo),
      kind: link.kind,
      number: link.externalNumber,
      title: link.title,
      state: link.state,
      mergeCommitSha: link.mergeCommitSha,
      ...(isDetailed && {
        url: link.url,
        repoId: link.repoId,
        mergedAt: link.mergedAt,
        refreshedAt: link.refreshedAt,
        createdAt: link.createdAt,
        createdByUserId: link.createdByUserId,
      }),
      closers: link.closers.map(closer => ({
        number: closer.prNumber,
        title: closer.title,
        state: closer.state,
        mergeCommitSha: closer.mergeCommitSha,
        ...(isDetailed && { url: closer.url, mergedAt: closer.mergedAt }),
      })),
    })),
  };
}

/** Search one of the project's repos, or each of them in turn; a project without repos is refused. */
export async function searchGithub(
  deps: FeedbackLinkToolDeps,
  args: SearchGithubArgs,
  userId: string,
): Promise<CallToolResult> {
  try {
    const scope = await resolveFeedbackProject(deps, userId, args);
    const repos = await deps.feedbackLinks.repos(scope);
    if (repos.length === 0) {
      return refused(
        "This project links no GitHub repository, so there is nothing to search. Link one in the project's settings in the Mocco console first.",
      );
    }
    const targets = args.repoId === undefined ? repos : repos.filter(repo => repo.id === args.repoId);
    if (args.repoId !== undefined && targets.length === 0) {
      // Another project's or workspace's repo reads like one that does not exist.
      return refused(new FeedbackLinkRepoNotFoundError(args.repoId).message);
    }
    const isDetailed = args.responseFormat === 'detailed';
    const results = await targets.reduce<Promise<Record<string, unknown>[]>>(async (previous, repo) => {
      const done = await previous;
      const items = await deps.feedbackLinks.search(
        scope,
        { repoId: repo.id, kind: args.kind, query: args.query },
        args.limit,
      );
      return [
        ...done,
        ...items.map(item => ({
          repoId: repo.id,
          repo: `${repo.owner}/${repo.name}`,
          kind: item.kind,
          number: item.number,
          title: item.title,
          state: item.state,
          ...(isDetailed && { url: item.url }),
        })),
      ];
    }, Promise.resolve([]));
    return asJson({ repos: repos.map(repo => ({ id: repo.id, name: `${repo.owner}/${repo.name}` })), results });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const linkWords: DecisionWords = {
  verb: 'link feedback posts to GitHub',
  doing: 'Linking a feedback post to GitHub',
  scope: { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS },
  instead: 'link it from the post in the Mocco console',
};
const unlinkWords: DecisionWords = {
  verb: 'unlink feedback posts from GitHub',
  doing: "Removing a feedback post's GitHub link",
  scope: { name: McpScopes.feedbackWrite, allows: FEEDBACK_WRITE_ALLOWS },
  instead: 'unlink it from the post in the Mocco console',
};

/** Link an issue or pull request to a post as the caller, once they confirm it as GitHub has it now. */
export async function linkPost(
  deps: FeedbackLinkToolDeps,
  args: LinkArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, linkWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const input = { repoId: args.repoId, kind: args.kind, number: args.number };
    // Every refusal the link would meet, read before anyone is asked.
    const { post, repo, item } = await deps.feedbackLinks.preview(scope, args.postId, input);
    // Bound to the target as GitHub has it now: if its state changes before the answer, ask again.
    const change = {
      tool: FEEDBACK_LINK_TOOL,
      ...scope,
      postId: post.id,
      repoId: repo.id,
      kind: item.kind,
      number: item.number,
      state: item.state,
    };
    const question = [
      `Link feedback post ${postLabel(post)} to ${targetLabel(item.kind, item.number)} of ${repo.owner}/${repo.name}, as you?`,
      `"${item.title}" (${item.state})`,
      item.url,
      'The post page shows the link and its state, kept current from GitHub, and it is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Link it',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const link = await deps.feedbackLinks.link(scope, userId, post.id, input);
        return asJson({
          linked: true,
          linkId: link.id,
          postId: link.postId,
          repo: repoName(repo),
          kind: link.kind,
          number: link.externalNumber,
          state: link.state,
          mergeCommitSha: link.mergeCommitSha,
        });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

/** Remove a post's link as the caller, once they confirm the link as it is now. */
export async function unlinkPost(
  deps: FeedbackLinkToolDeps,
  args: UnlinkArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, unlinkWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveFeedbackProject(deps, userId, { workspaceId, projectId: args.projectId });
    const link = await deps.feedbackLinks.requireLink(scope, args.linkId);
    const post = await deps.feedbackPosts.requirePost(scope, link.postId);
    // Bound to the link as it is now: if GitHub changes its state before the answer, ask again.
    const change = {
      tool: FEEDBACK_UNLINK_TOOL,
      ...scope,
      linkId: link.id,
      postId: link.postId,
      repoId: link.repoId,
      kind: link.kind,
      number: link.externalNumber,
      state: link.state,
    };
    const question = [
      `Unlink ${targetLabel(link.kind, link.externalNumber)} of ${repoName(link.repo) ?? 'a removed repo'} from feedback post ${postLabel(post)}, as you?`,
      `"${link.title}" (${link.state})`,
      'Nothing changes on GitHub. The post page stops showing it, and it is recorded in the audit trail.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Unlink it',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        await deps.feedbackLinks.unlink(scope, userId, link.id);
        return asJson({ unlinked: true, linkId: link.id, postId: link.postId });
      },
    });
  } catch (error) {
    return feedbackRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.feedbackWrite, `${doing} needs your permission for this app to change your feedback posts`);

export function registerFeedbackLinkTools(server: McpServer, deps: FeedbackLinkToolDeps): void {
  server.registerTool(
    'mocco_feedback_links_list',
    {
      title: "List a feedback post's GitHub links",
      description:
        "The GitHub issues and pull requests a feedback post links, oldest first: each one's state (`open`, `closed`, or `merged`), the merge commit of a merged pull request, and the pull requests that close a linked issue. Webhooks keep them current. Read-only.",
      inputSchema: linksInput,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => asJson(await listLinks(deps, args, userIdOf(ctx))),
  );

  server.registerTool(
    'mocco_feedback_github_search',
    {
      title: 'Find GitHub issues or pull requests to link',
      description:
        "Search the GitHub repos linked to a feedback project for issues or pull requests, by words or by number, to link one to a post with `mocco_feedback_post_link`. Searches every linked repo unless `repoId` names one. Needs the server's GitHub App. Read-only.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, ctx) => await searchGithub(deps, args, userIdOf(ctx)),
  );

  server.registerTool(
    FEEDBACK_LINK_TOOL,
    {
      title: 'Link a GitHub issue or pull request to a feedback post',
      description:
        "Link an issue or pull request of one of the project's GitHub repos to a feedback post, as the signed-in person, exactly as the post page in the console does: the link keeps its state and merge commit current, and it is recorded in the audit trail. The person confirms the post and the issue or pull request (with its state now) in their client first, and it only works where the workspace allows agents to make changes.",
      inputSchema: linkInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      scopeChallenge: challenge('Linking a post'),
    },
    async (args, ctx) => await linkPost(deps, args, ctx),
  );

  server.registerTool(
    FEEDBACK_UNLINK_TOOL,
    {
      title: "Remove a feedback post's GitHub link",
      description:
        'Remove a GitHub link from a feedback post, as the signed-in person, exactly as the post page in the console does; nothing changes on GitHub, and it is recorded in the audit trail. The person confirms the link (with its state now) in their client first, and it only works where the workspace allows agents to make changes.',
      inputSchema: unlinkInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      scopeChallenge: challenge('Unlinking a post'),
    },
    async (args, ctx) => await unlinkPost(deps, args, ctx),
  );
}
