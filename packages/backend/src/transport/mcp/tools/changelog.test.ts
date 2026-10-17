// `mocco_changelog_*` over a real database, through the real HTTP handler.
//
// The reads stay inside the caller's project. Every change has the locks a changing tool has
// (`feedback:write`, the workspace's opt-in, a confirmation naming the entry and what would
// change), writes nothing until the person says yes, and refuses an answer once the entry was
// edited, published or scheduled by anyone since. A move the entry's state doesn't allow is
// refused before asking.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ChangelogEntryStates, ChangelogTags } from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectOne } from '@backend/infra/db/rows';
import { auditLog, changelogEntries } from '@backend/infra/db/schema';
import {
  WRITE,
  createFeedbackHarness,
  isAsking,
  messageOf,
  textOf,
} from '@backend/transport/mcp/testing/feedback-harness';

import type { FeedbackHarness, RpcAnswer } from '@backend/transport/mcp/testing/feedback-harness';

const SEARCH = 'mocco_changelog_entries_search';
const GET = 'mocco_changelog_entry_get';
const CREATE = 'mocco_changelog_entry_create';
const UPDATE = 'mocco_changelog_entry_update';
const PUBLISH = 'mocco_changelog_entry_publish';
const SCHEDULE = 'mocco_changelog_entry_schedule';
const UNPUBLISH = 'mocco_changelog_entry_unpublish';
const DELETE = 'mocco_changelog_entry_delete';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

function expectRefused(refusal: RpcAnswer) {
  expect(refusal.result?.isError, textOf(refusal)).toBe(true);
  expect(isAsking(refusal)).toBe(false);
}

describe('mocco_changelog entries (pglite, over HTTP)', () => {
  let h: FeedbackHarness;
  let ideas: string;
  let darkMode: string;
  /** A draft announcing dark mode, and a published entry. */
  let draft: string;
  let published: string;
  let foreignEntry: string;

  const entryRow = async (id: string) =>
    await h.t.db.select().from(changelogEntries).where(eq(changelogEntries.id, id));

  async function asks(tool: string, args: Row) {
    const { asked, requestState } = await h.ask(tool, args);
    expect(isAsking(asked), textOf(asked)).toBe(true);
    return { message: messageOf(asked), requestState };
  }

  const changes = (): [string, Row][] => [
    [CREATE, { boardId: ideas, title: 'X' }],
    [UPDATE, { entryId: draft, title: 'X' }],
    [PUBLISH, { entryId: draft }],
    [SCHEDULE, { entryId: draft, publishAt: '2027-01-01T00:00:00Z' }],
    [UNPUBLISH, { entryId: published }],
    [DELETE, { entryId: draft }],
  ];

  beforeEach(async () => {
    h = await createFeedbackHarness();
    const { feedback, mine, theirs, ada, eve } = h;
    ({ id: ideas } = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' }));
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas, title: 'Dark mode' }));
    ({ id: draft } = await feedback.feedbackChangelog.create(mine, ada, {
      boardId: ideas,
      title: 'Dark mode is here',
      body: 'Switch it on in settings. '.repeat(40),
      tags: [ChangelogTags.new],
      postIds: [darkMode],
    }));
    ({ id: published } = await feedback.feedbackChangelog.create(mine, ada, { boardId: ideas, title: 'Faster sync' }));
    await feedback.feedbackChangelog.publish(mine, ada, published);
    const theirBoard = await feedback.feedbackBoards.createBoard(theirs, eve, { slug: 'ideas', name: 'Theirs' });
    ({ id: foreignEntry } = await feedback.feedbackChangelog.create(theirs, eve, {
      boardId: theirBoard.id,
      title: 'Their secret launch',
    }));
  });
  afterEach(async () => {
    await h.close();
  });

  describe('reads', () => {
    it("searches a board's entries by state, paged, and reads one with its text cut unless detailed", async () => {
      const all = bodyOf(await h.call(SEARCH, { boardId: ideas }));
      expect(new Set((all.entries as Row[]).map(entry => entry.id))).toEqual(new Set([published, draft]));
      const drafts = bodyOf(await h.call(SEARCH, { boardId: ideas, state: ChangelogEntryStates.draft, limit: 1 }));
      expect(drafts.entries).toEqual([expect.objectContaining({ id: draft, postCount: 1, tags: [ChangelogTags.new] })]);
      expect(drafts).not.toHaveProperty('nextOffset');
      const paged = bodyOf(await h.call(SEARCH, { boardId: ideas, limit: 1 }));
      expect(paged.nextOffset).toBe(1);

      const concise = bodyOf(await h.call(GET, { entryId: draft }));
      expect(concise.entry).toMatchObject({ id: draft, isBodyCut: true, postIds: [darkMode] });
      const detailed = bodyOf(await h.call(GET, { entryId: draft, responseFormat: 'detailed' }));
      expect(detailed.entry).toMatchObject({
        body: 'Switch it on in settings. '.repeat(40),
        createdByUserId: h.ada,
      });
    });

    it("refuses another workspace's entry exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const theirs = await h.call(GET, { entryId: foreignEntry });
      const missing = await h.call(GET, { entryId: nowhere });
      expect(theirs.result?.isError).toBe(true);
      expect(textOf(theirs).replace(foreignEntry, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(theirs)).not.toContain('secret');
    });
  });

  describe('writing', () => {
    it('starts a draft once confirmed, with an address made from the title, and nothing on a no', async () => {
      const args = { boardId: ideas, title: 'CSV export', tags: [ChangelogTags.improved], postIds: [darkMode] };
      const { message, requestState } = await asks(CREATE, args);
      expect(message).toContain('"CSV export" as a draft');
      expect(message).toContain('Address: made from the title');
      expect(bodyOf(await h.answer(CREATE, args, requestState, false))).toMatchObject({ changed: false });
      const created = bodyOf(await h.confirmed(CREATE, args));
      expect(created).toMatchObject({ created: true, slug: 'csv-export', state: ChangelogEntryStates.draft });
    });

    it('edits only what changes, says a published page changes at once, and refuses a stale answer', async () => {
      const { message } = await asks(UPDATE, {
        entryId: published,
        title: 'Much faster sync',
        tags: [ChangelogTags.improved],
      });
      expect(message).toContain('Title: "Faster sync" → "Much faster sync"');
      expect(message).toContain('Tags: none → improved');
      expect(message).toContain('public page changes at once');

      const args = { entryId: draft, title: 'Dark mode, finally' };
      const { requestState } = await asks(UPDATE, args);
      await h.feedback.feedbackChangelog.update(h.mine, draft, { body: 'Edited meanwhile' });
      expect(textOf(await h.answer(UPDATE, args, requestState))).toContain('different change');
      expect(bodyOf(await h.confirmed(UPDATE, args))).toMatchObject({ changed: true, title: 'Dark mode, finally' });
      const same = await h.call(UPDATE, { entryId: draft, title: 'Dark mode, finally' }, WRITE);
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });
  });

  describe('publishing', () => {
    it('publishes once confirmed, audited as the person, and refuses publishing it again before asking', async () => {
      const { message } = await asks(PUBLISH, { entryId: draft });
      expect(message).toContain('It is a draft');
      expect(message).toContain('announces 1 post');
      expect(bodyOf(await h.confirmed(PUBLISH, { entryId: draft }))).toMatchObject({
        state: ChangelogEntryStates.published,
      });
      const audit = await h.t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditActions.changelogEntryPublished));
      expect(audit.find(row => row.subjectId === draft)?.actorUserId).toBe(h.ada);
      expectRefused(await h.call(PUBLISH, { entryId: draft }, WRITE));
    });

    it('schedules a draft at a time ahead, refuses a past time when answered, and refuses a stale answer', async () => {
      const ahead = { entryId: draft, publishAt: '2027-01-01T09:00:00Z' };
      const { message, requestState } = await asks(SCHEDULE, ahead);
      expect(message).toContain('2027-01-01T09:00:00.000Z');
      await h.feedback.feedbackChangelog.publish(h.mine, h.ada, draft);
      expectRefused(await h.answer(SCHEDULE, ahead, requestState));

      const fresh = await h.feedback.feedbackChangelog.create(h.mine, h.ada, { boardId: ideas, title: 'Later' });
      const past = await h.confirmed(SCHEDULE, { entryId: fresh.id, publishAt: '2020-01-01T00:00:00Z' });
      expectRefused(past);
      expect(textOf(past)).toContain('publish time has passed');
      expectRefused(await h.call(SCHEDULE, { entryId: published, publishAt: '2027-01-01T09:00:00Z' }, WRITE));
    });

    it('unpublishes a published entry once confirmed, and refuses a draft before asking', async () => {
      const { message } = await asks(UNPUBLISH, { entryId: published });
      expect(message).toContain('leaves the public changelog');
      expect(bodyOf(await h.confirmed(UNPUBLISH, { entryId: published }))).toMatchObject({
        state: ChangelogEntryStates.draft,
      });
      expectRefused(await h.call(UNPUBLISH, { entryId: draft }, WRITE));
    });

    it('deletes once confirmed, naming a published entry as public, and audits it', async () => {
      const { message } = await asks(DELETE, { entryId: published });
      expect(message).toContain('It is published');
      expect(message).toContain('cannot be undone');
      expect(bodyOf(await h.confirmed(DELETE, { entryId: published }))).toMatchObject({ deleted: true });
      expect(await entryRow(published)).toEqual([]);
      const audit = await h.t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.changelogEntryDeleted));
      expect(audit.map(row => row.actorUserId)).toEqual([h.ada]);
    });

    it("refuses another workspace's entry for every change, and leaves it as it is", async () => {
      const answers = await [UPDATE, PUBLISH, UNPUBLISH, DELETE].reduce<Promise<RpcAnswer[]>>(
        async (previous, tool) => {
          const done = await previous;
          return [...done, await h.call(tool, { entryId: foreignEntry, title: 'Mine' }, WRITE)];
        },
        Promise.resolve([]),
      );
      expect(answers.map(answer => [answer.result?.isError, isAsking(answer)])).toEqual(
        answers.map(() => [true, false]),
      );
      expect(expectOne(await entryRow(foreignEntry))).toMatchObject({ title: 'Their secret launch' });
    });
  });

  describe('locks', () => {
    it('challenges a token without feedback:write, and refuses without the opt-in', async () => {
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await h.call(tool, args);
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
      }, Promise.resolve());
      await h.settings.setAgentsMayDecide(h.mine.workspaceId, false, h.ada);
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const refusal = await h.call(tool, args, WRITE);
        expectRefused(refusal);
        expect(textOf(refusal), tool).toContain('Settings → Agents');
      }, Promise.resolve());
    });

    it('marks the reads read-only and deleting destructive', async () => {
      const tools = await h.listTools();
      const hintsOf = (name: string) => tools.find(each => each.name === name)?.annotations;
      expect(hintsOf(SEARCH)).toMatchObject({ readOnlyHint: true });
      expect(hintsOf(GET)).toMatchObject({ readOnlyHint: true });
      expect(hintsOf(DELETE)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      const changing = [CREATE, UPDATE, PUBLISH, SCHEDULE, UNPUBLISH];
      expect(changing.map(name => hintsOf(name))).toEqual(
        changing.map(() => expect.objectContaining({ readOnlyHint: false, destructiveHint: false })),
      );
    });
  });
});
