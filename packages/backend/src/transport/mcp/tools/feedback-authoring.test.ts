// `mocco_feedback_board_get` and the board, category and post changes over a real database,
// through the real HTTP handler.
//
// The read stays inside the caller's project. Every change has the locks a changing tool has
// (`feedback:write`, the workspace's opt-in, a confirmation naming exactly what would change),
// writes nothing until the person says yes, and refuses an answer once what it was asked about
// has changed. A taken address is refused before asking.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostStatuses, ShipModes, ShipPolicies } from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedRepo } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, feedbackBoards, feedbackCategories, feedbackPosts } from '@backend/infra/db/schema';
import {
  WRITE,
  createFeedbackHarness,
  isAsking,
  messageOf,
  textOf,
} from '@backend/transport/mcp/testing/feedback-harness';

import type { FeedbackHarness, RpcAnswer } from '@backend/transport/mcp/testing/feedback-harness';

const GET = 'mocco_feedback_board_get';
const BOARD_CREATE = 'mocco_feedback_board_create';
const BOARD_UPDATE = 'mocco_feedback_board_update';
const POLICY = 'mocco_feedback_board_release_policy_set';
const CATEGORY_CREATE = 'mocco_feedback_category_create';
const CATEGORY_UPDATE = 'mocco_feedback_category_update';
const CATEGORY_DELETE = 'mocco_feedback_category_delete';
const POST_CREATE = 'mocco_feedback_post_create';
const POST_UPDATE = 'mocco_feedback_post_update';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

/** Refused, and not asked. */
function expectRefused(refusal: RpcAnswer) {
  expect(refusal.result?.isError, textOf(refusal)).toBe(true);
  expect(isAsking(refusal)).toBe(false);
}

describe('mocco_feedback boards, categories and posts (pglite, over HTTP)', () => {
  let h: FeedbackHarness;
  let ideas: string;
  let mobile: string;
  let web: string;
  /** In mobile, on ideas. */
  let darkMode: string;
  let foreignBoard: string;
  let foreignCategory: string;
  let foreignPost: string;

  const boardRow = async (id: string) =>
    expectOne(await h.t.db.select().from(feedbackBoards).where(eq(feedbackBoards.id, id)));
  const postRow = async (id: string) =>
    expectOne(await h.t.db.select().from(feedbackPosts).where(eq(feedbackPosts.id, id)));
  const categoriesOf = async (boardId: string) =>
    await h.t.db.select().from(feedbackCategories).where(eq(feedbackCategories.boardId, boardId));

  async function asks(tool: string, args: Row) {
    const { asked, requestState } = await h.ask(tool, args);
    expect(isAsking(asked), textOf(asked)).toBe(true);
    return { message: messageOf(asked), requestState };
  }

  const changes = (): [string, Row][] => [
    [BOARD_CREATE, { slug: 'x', name: 'X' }],
    [BOARD_UPDATE, { boardId: ideas, name: 'X' }],
    [POLICY, { boardId: ideas, shipMode: ShipModes.autoApply }],
    [CATEGORY_CREATE, { boardId: ideas, slug: 'x', name: 'X' }],
    [CATEGORY_UPDATE, { boardId: ideas, categoryId: web, name: 'X' }],
    [CATEGORY_DELETE, { boardId: ideas, categoryId: web }],
    [POST_CREATE, { boardId: ideas, title: 'X' }],
    [POST_UPDATE, { postId: darkMode, title: 'X' }],
  ];

  beforeEach(async () => {
    h = await createFeedbackHarness();
    const { feedback, mine, theirs, ada, eve } = h;
    ({ id: ideas } = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' }));
    await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'bugs', name: 'Bugs' });
    ({ id: mobile } = await feedback.feedbackBoards.createCategory(mine, ideas, { slug: 'mobile', name: 'Mobile' }));
    ({ id: web } = await feedback.feedbackBoards.createCategory(mine, ideas, { slug: 'web', name: 'Web' }));
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, {
      boardId: ideas,
      title: 'Dark mode',
      body: 'Too bright at night',
      categoryId: mobile,
    }));
    ({ id: foreignBoard } = await feedback.feedbackBoards.createBoard(theirs, eve, { slug: 'ideas', name: 'Theirs' }));
    ({ id: foreignCategory } = await feedback.feedbackBoards.createCategory(theirs, foreignBoard, {
      slug: 'secret',
      name: 'Secret',
    }));
    ({ id: foreignPost } = await feedback.feedbackPosts.create(theirs, eve, {
      boardId: foreignBoard,
      title: 'Their secret plan',
    }));
  });
  afterEach(async () => {
    await h.close();
  });

  describe(GET, () => {
    it('reads the board with its release policy and categories, concise unless asked', async () => {
      const concise = bodyOf(await h.call(GET, { boardId: ideas }));
      expect(concise.board).toEqual({
        id: ideas,
        slug: 'ideas',
        name: 'Ideas',
        isPublic: true,
        releasePolicy: {
          releaseRepoId: null,
          releaseStepName: null,
          shipPolicy: ShipPolicies.allLinksShipped,
          shipMode: ShipModes.suggest,
        },
      });
      expect(concise.categories).toEqual([
        { id: mobile, name: 'Mobile' },
        { id: web, name: 'Web' },
      ]);
      const detailed = bodyOf(await h.call(GET, { boardId: ideas, responseFormat: 'detailed' }));
      expect(detailed.board).toHaveProperty('createdAt');
      expect(detailed.categories).toEqual([
        { id: mobile, name: 'Mobile', slug: 'mobile', position: 0 },
        { id: web, name: 'Web', slug: 'web', position: 1 },
      ]);
    });

    it("refuses another workspace's board exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const theirs = await h.call(GET, { boardId: foreignBoard });
      const missing = await h.call(GET, { boardId: nowhere });
      expect(theirs.result?.isError).toBe(true);
      expect(textOf(theirs).replace(foreignBoard, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    });
  });

  describe('boards', () => {
    it('creates a board once confirmed, audited, and nothing before or on a no', async () => {
      const args = { slug: 'roadmap', name: 'Roadmap', isPublic: false };
      const { message, requestState } = await asks(BOARD_CREATE, args);
      expect(message).toContain('"Roadmap" (roadmap)');
      expect(message).toContain('private');
      expect(bodyOf(await h.answer(BOARD_CREATE, args, requestState, false))).toMatchObject({ changed: false });
      expect(await h.feedback.feedbackBoards.listBoards(h.mine)).toHaveLength(2);

      const created = bodyOf(await h.confirmed(BOARD_CREATE, args));
      expect(created).toMatchObject({ created: true, slug: 'roadmap', isPublic: false });
      const audit = await h.t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackBoardCreated));
      expect(audit.find(row => row.subjectId === created.boardId)?.actorUserId).toBe(h.ada);
    });

    it('refuses a taken address before asking', async () => {
      expectRefused(await h.call(BOARD_CREATE, { slug: 'bugs', name: 'More bugs' }, WRITE));
      expectRefused(await h.call(BOARD_UPDATE, { boardId: ideas, slug: 'bugs' }, WRITE));
    });

    it('changes only the fields given, naming each from and to, and answers without asking when nothing changes', async () => {
      const args = { boardId: ideas, name: 'Feature requests', isPublic: false };
      const { message } = await asks(BOARD_UPDATE, args);
      expect(message).toContain('Name: "Ideas" → "Feature requests"');
      expect(message).toContain('Visibility: public (end users see it) → private (only the team sees it)');
      expect(message).not.toContain('Address');
      expect(bodyOf(await h.confirmed(BOARD_UPDATE, args))).toMatchObject({ changed: true, slug: 'ideas' });
      expect(await boardRow(ideas)).toMatchObject({ name: 'Feature requests', slug: 'ideas', isPublic: false });

      const same = await h.call(BOARD_UPDATE, { boardId: ideas, name: 'Feature requests' }, WRITE);
      expect(isAsking(same)).toBe(false);
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('refuses an answer once the board was changed by someone else, and asks again with what is there', async () => {
      const args = { boardId: ideas, slug: 'features' };
      const { requestState } = await asks(BOARD_UPDATE, args);
      await h.feedback.feedbackBoards.updateBoard(h.mine, ideas, { slug: 'ideas', name: 'Renamed' });
      const stale = await h.answer(BOARD_UPDATE, args, requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await boardRow(ideas)).toMatchObject({ slug: 'ideas' });
      const again = await asks(BOARD_UPDATE, args);
      expect(again.message).toContain('"Renamed"');
    });

    it('has no tool that deletes a board', async () => {
      const tools = await h.listTools();
      const boardTools = tools.filter(tool => tool.name.startsWith('mocco_feedback_board_'));
      expect(boardTools.map(tool => tool.name)).toEqual([GET, BOARD_CREATE, BOARD_UPDATE, POLICY]);
    });
  });

  describe(POLICY, () => {
    it("sets the release policy once confirmed, saying what auto-apply does, audited as the person's", async () => {
      const repoId = await seedRepo(h.t.db, h.mine.workspaceId, 'api', [h.mine.projectId]);
      const args = { boardId: ideas, releaseRepoId: repoId, releaseStepName: 'deploy', shipMode: ShipModes.autoApply };
      const { message } = await asks(POLICY, args);
      expect(message).toContain('Shipping on release: off');
      expect(message).toContain(`repo ${repoId}, only runs that succeeded the step "deploy"`);
      expect(message).toContain('without asking');
      const set = bodyOf(await h.confirmed(POLICY, args));
      expect(set.releasePolicy).toEqual({
        releaseRepoId: repoId,
        releaseStepName: 'deploy',
        shipPolicy: ShipPolicies.allLinksShipped,
        shipMode: ShipModes.autoApply,
      });
      const audit = await h.t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditActions.feedbackBoardReleasePolicyChanged));
      expect(audit.map(row => row.actorUserId)).toEqual([h.ada]);

      const same = await h.call(POLICY, { boardId: ideas, shipMode: ShipModes.autoApply }, WRITE);
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('refuses a repo outside the project when the answer comes, and changes nothing', async () => {
      const theirRepo = await seedRepo(h.t.db, h.theirs.workspaceId, 'api', [h.theirs.projectId]);
      const refusal = await h.confirmed(POLICY, { boardId: ideas, releaseRepoId: theirRepo });
      expectRefused(refusal);
      expect(textOf(refusal)).toContain('not linked to this project');
      expect(await boardRow(ideas)).toMatchObject({ releaseRepoId: null });
    });
  });

  describe('categories', () => {
    it('adds, renames and deletes a category once each is confirmed', async () => {
      const created = bodyOf(await h.confirmed(CATEGORY_CREATE, { boardId: ideas, slug: 'api', name: 'API' }));
      expect(created).toMatchObject({ created: true, position: 2 });
      const categoryId = String(created.categoryId);

      const rename = { boardId: ideas, categoryId, name: 'Public API', position: 0 };
      const { message } = await asks(CATEGORY_UPDATE, rename);
      expect(message).toContain('Name: "API" → "Public API"');
      expect(message).toContain('Position: 2 → 0');
      expect(bodyOf(await h.confirmed(CATEGORY_UPDATE, rename))).toMatchObject({ changed: true, position: 0 });

      expect(bodyOf(await h.confirmed(CATEGORY_DELETE, { boardId: ideas, categoryId }))).toMatchObject({
        deleted: true,
      });
      const left = await categoriesOf(ideas);
      expect(new Set(left.map(row => row.slug))).toEqual(new Set(['mobile', 'web']));
    });

    it('says how many posts a deleted category leaves uncategorized, and they stay on the board', async () => {
      const { message } = await asks(CATEGORY_DELETE, { boardId: ideas, categoryId: mobile });
      expect(message).toContain('Its 1 post stays on the board, with no category');
      expect(message).toContain('cannot be undone');
      await h.confirmed(CATEGORY_DELETE, { boardId: ideas, categoryId: mobile });
      expect(await postRow(darkMode)).toMatchObject({ boardId: ideas, categoryId: null });
    });

    it('refuses a delete answered after the category was renamed', async () => {
      const args = { boardId: ideas, categoryId: web };
      const { requestState } = await asks(CATEGORY_DELETE, args);
      await h.feedback.feedbackBoards.updateCategory(h.mine, web, { slug: 'web', name: 'Website' });
      expect(textOf(await h.answer(CATEGORY_DELETE, args, requestState))).toContain('different change');
      expect(await categoriesOf(ideas)).toHaveLength(2);
    });

    it("refuses a taken address, and another board's or workspace's category, before asking", async () => {
      expectRefused(await h.call(CATEGORY_CREATE, { boardId: ideas, slug: 'web', name: 'Web 2' }, WRITE));
      expectRefused(await h.call(CATEGORY_UPDATE, { boardId: ideas, categoryId: web, slug: 'mobile' }, WRITE));
      const theirs = await h.call(CATEGORY_DELETE, { boardId: ideas, categoryId: foreignCategory }, WRITE);
      const nowhere = randomUUID();
      const missing = await h.call(CATEGORY_DELETE, { boardId: ideas, categoryId: nowhere }, WRITE);
      expectRefused(theirs);
      expect(textOf(theirs).replace(foreignCategory, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await categoriesOf(foreignBoard)).toHaveLength(1);
    });
  });

  describe('posts', () => {
    it('writes a post as the person once they confirm its words, category and status', async () => {
      const args = {
        boardId: ideas,
        title: 'CSV export',
        body: 'Every session, please',
        categoryId: web,
        status: FeedbackPostStatuses.planned,
      };
      const { message } = await asks(POST_CREATE, args);
      expect(message).toContain('"CSV export" on feedback board "Ideas" (ideas)');
      expect(message).toContain('Category: "Web"');
      expect(message).toContain('Status: planned');
      expect(message).toContain('Every session, please');
      const created = bodyOf(await h.confirmed(POST_CREATE, args));
      expect(created).toMatchObject({
        created: true,
        number: 2,
        status: FeedbackPostStatuses.planned,
        categoryId: web,
      });
      expect(await postRow(String(created.postId))).toMatchObject({
        authorUserId: h.ada,
        body: 'Every session, please',
      });
    });

    it('refuses a category of another board before asking', async () => {
      expectRefused(await h.call(POST_CREATE, { boardId: ideas, title: 'X', categoryId: foreignCategory }, WRITE));
      expectRefused(await h.call(POST_UPDATE, { postId: darkMode, categoryId: foreignCategory }, WRITE));
    });

    it('edits only the fields given, and takes a post out of its category with null', async () => {
      const args = { postId: darkMode, title: 'Dark mode everywhere', categoryId: null };
      const { message } = await asks(POST_UPDATE, args);
      expect(message).toContain('Title: "Dark mode" → "Dark mode everywhere"');
      expect(message).toContain('Category: "Mobile" → none');
      expect(message).not.toContain('Details');
      expect(bodyOf(await h.confirmed(POST_UPDATE, args))).toMatchObject({ changed: true, categoryId: null });
      expect(await postRow(darkMode)).toMatchObject({
        title: 'Dark mode everywhere',
        body: 'Too bright at night',
        categoryId: null,
      });
      const same = await h.call(POST_UPDATE, { postId: darkMode, title: 'Dark mode everywhere' }, WRITE);
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('refuses an edit answered after the body was changed by someone else', async () => {
      const args = { postId: darkMode, title: 'Night mode' };
      const { requestState } = await asks(POST_UPDATE, args);
      await h.feedback.feedbackPosts.update(h.mine, darkMode, { body: 'Edited meanwhile' });
      expect(textOf(await h.answer(POST_UPDATE, args, requestState))).toContain('different change');
      expect(await postRow(darkMode)).toMatchObject({ title: 'Dark mode' });
    });

    it("refuses another workspace's post exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const theirs = await h.call(POST_UPDATE, { postId: foreignPost, title: 'Mine now' }, WRITE);
      const missing = await h.call(POST_UPDATE, { postId: nowhere, title: 'Mine now' }, WRITE);
      expectRefused(theirs);
      expect(textOf(theirs).replace(foreignPost, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await postRow(foreignPost)).toMatchObject({ title: 'Their secret plan' });
    });
  });

  describe('locks', () => {
    it('challenges a token without feedback:write for it, keeping the scopes it has', async () => {
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await h.call(tool, args);
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
        expect(challenged.wwwAuthenticate).toContain('openid');
      }, Promise.resolve());
    });

    it('refuses where the workspace has not allowed agents to make changes, and says where to change it', async () => {
      await h.settings.setAgentsMayDecide(h.mine.workspaceId, false, h.ada);
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const refusal = await h.call(tool, args, WRITE);
        expectRefused(refusal);
        expect(textOf(refusal), tool).toContain('Settings → Agents');
      }, Promise.resolve());
    });
  });

  it('marks the read read-only, deleting a category destructive and the others as changes', async () => {
    const tools = await h.listTools();
    const hintsOf = (name: string) => tools.find(each => each.name === name)?.annotations;
    expect(hintsOf(GET)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(CATEGORY_DELETE)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const names = [BOARD_CREATE, BOARD_UPDATE, POLICY, CATEGORY_CREATE, CATEGORY_UPDATE, POST_CREATE, POST_UPDATE];
    expect(names.map(name => hintsOf(name))).toEqual(
      names.map(() => expect.objectContaining({ readOnlyHint: false, destructiveHint: false })),
    );
  });
});
