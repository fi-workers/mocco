import { randomUUID } from 'node:crypto';

import { SegmentChanges } from '@mocco/common/help';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import {
  HelpLocaleNotOfferedError,
  HelpNodeNotFoundError,
  HelpNoProposalError,
} from '@backend/domain/helpcenter/errors';
import { segmentMarkdown, segmentTitle } from '@backend/domain/helpcenter/markdown/segment';
import { HelpSegmentMemoryRepo } from '@backend/domain/helpcenter/repos/segment-memory.repo';
import { segmentDiff } from '@backend/domain/helpcenter/translate/diff';
import { FakeTranslator } from '@backend/domain/helpcenter/translate/testing/fake-translator';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';

const BODY = '## Add the widget\n\nTap [here](https://a.test).\n\n```\nnpm i\n```';
const EDITED = '## Add the widget\n\nPress [here](https://a.test).\n\n```\nnpm i\n```\n\nNew line.';
const NOW = new Date('2026-10-06T09:00:00Z');

const segmentsOf = (title: string, body: string) => [segmentTitle(title), ...segmentMarkdown(body)];

describe('segment diff', () => {
  it('pairs a changed segment with the one in its place and keeps the rest in order', () => {
    const diff = segmentDiff(segmentsOf('Widget', BODY), segmentsOf('Widget', EDITED));

    expect(diff).toEqual([
      { change: SegmentChanges.same, kind: 'title', before: 'Widget', after: 'Widget' },
      { change: SegmentChanges.same, kind: 'heading', before: 'Add the widget', after: 'Add the widget' },
      { change: SegmentChanges.changed, kind: 'paragraph', before: 'Tap here.', after: 'Press here.' },
      { change: SegmentChanges.added, kind: 'paragraph', before: null, after: 'New line.' },
    ]);
  });

  it('shows a removed segment, and nothing changed for the same text', () => {
    const removed = segmentDiff(segmentsOf('Widget', `${BODY}\n\nOld line.`), segmentsOf('Widget', BODY));
    const same = segmentDiff(segmentsOf('Widget', BODY), segmentsOf('Widget', BODY));

    expect(removed.at(-1)).toEqual({
      change: SegmentChanges.removed,
      kind: 'paragraph',
      before: 'Old line.',
      after: null,
    });
    expect(same.every(entry => entry.change === SegmentChanges.same)).toBe(true);
  });
});

describe('help center translation review (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;
  let reviewerId: string;
  let queued: { articleId: string; workspaceId: string; locale: string; fresh?: boolean }[];

  const domain = (): HelpDomain & { drain: () => Promise<void> } => {
    const help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator: new FakeTranslator(),
      now: () => NOW,
      queue: {
        enqueue: async (_job, payload) => {
          queued.push(payload as (typeof queued)[number]);
          return await Promise.resolve({ job: { id: randomUUID() } as never, created: true });
        },
        kick: () => {},
      },
    });
    return {
      ...help,
      drain: async () => {
        const jobs = [...queued];
        queued.length = 0;
        await Promise.all(jobs.map(async job => await help.helpTranslations.translateArticle(job)));
      },
    };
  };

  const republish = async (help: HelpDomain, articleId: string, body: string) => {
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, { articleId, title: 'Widget', body });
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, articleId);
  };

  /** A published English article, machine-translated into Korean. */
  const translated = async (help: HelpDomain & { drain: () => Promise<void> }) => {
    await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'en', locales: ['ko'] });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: 'Start',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
      sectionId: section.id,
      title: 'Widget',
      slug: 'widget',
    });
    await republish(help, article.id, BODY);
    await help.drain();
    return article;
  };

  const audited = async () => {
    const entries = await t.db.select().from(auditLog);
    return entries
      .filter(entry => entry.action.startsWith('help.translation.'))
      .map(entry => ({
        action: entry.action,
        actor: entry.actorUserId,
        subject: entry.subjectId,
        payload: entry.payload,
      }));
  };

  beforeEach(async () => {
    t = await createTestDb();
    queued = [];
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const person = async (name: string) =>
      expectOne(
        await t.db
          .insert(users)
          .values({ email: `${randomUUID()}@acme.test`, name })
          .returning(),
      ).id;
    authorId = await person('Ada');
    reviewerId = await person('Min-jun');
    const project = await createProjectDomain(t.db).projects.create(workspaceId, {
      name: 'ShowYourTime',
      handle: 'syt',
    });
    projectId = project.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('marks a translation reviewed with the reviewer and the time, and audits it', async () => {
    const help = domain();
    const article = await translated(help);
    const machine = await help.helpTranslations.review(workspaceId, projectId, article.id, 'ko');

    // Saving the machine's text as it is marks it reviewed.
    await help.helpTranslations.saveTranslation(workspaceId, projectId, reviewerId, {
      articleId: article.id,
      locale: 'ko',
      title: machine.text?.title ?? '',
      body: machine.text?.body ?? '',
    });
    const reviewed = await help.helpTranslations.review(workspaceId, projectId, article.id, 'ko');

    expect(machine).toMatchObject({ state: 'auto', textKind: 'machine', reviewedBy: null, reviewedAt: null });
    expect(reviewed).toMatchObject({
      state: 'reviewed',
      textKind: 'human_edit',
      text: machine.text,
      source: { title: 'Widget', body: BODY },
      reviewedBy: 'Min-jun',
      reviewedAt: NOW,
      isStale: false,
      changes: null,
      proposal: null,
    });
    expect(await audited()).toEqual([
      {
        action: 'help.translation.reviewed',
        actor: reviewerId,
        subject: article.id,
        payload: expect.objectContaining({ projectId, locale: 'ko' }),
      },
    ]);
  });

  it('shows exactly the source segments that changed, and accepts the machine draft as the reviewer’s', async () => {
    const help = domain();
    const article = await translated(help);
    await help.helpTranslations.saveTranslation(workspaceId, projectId, reviewerId, {
      articleId: article.id,
      locale: 'ko',
      title: '위젯',
      body: '## 위젯 추가\n\n[여기](https://a.test)를 누르세요.\n\n```\nnpm i\n```',
    });

    await republish(help, article.id, EDITED);
    await help.drain();
    const stale = await help.helpTranslations.review(workspaceId, projectId, article.id, 'ko');

    expect(stale).toMatchObject({ state: 'reviewed', isStale: true, text: { title: '위젯' } });
    expect(stale.changes?.filter(entry => entry.change !== SegmentChanges.same)).toEqual([
      { change: 'changed', kind: 'paragraph', before: 'Tap here.', after: 'Press here.' },
      { change: 'added', kind: 'paragraph', before: null, after: 'New line.' },
    ]);
    // The person's unchanged sentences are kept in the draft; the changed ones are drafted.
    expect(stale.proposal).toMatchObject({ title: '위젯' });
    expect(stale.proposal?.body).toContain('## 위젯 추가');
    expect(stale.proposal?.body).toContain('KO New line.');

    const accepted = await help.helpTranslations.acceptProposal(workspaceId, projectId, authorId, {
      articleId: article.id,
      locale: 'ko',
      proposalRevisionId: stale.proposal?.revisionId ?? '',
    });

    expect(accepted).toMatchObject({
      state: 'reviewed',
      isStale: false,
      changes: null,
      proposal: null,
      textKind: 'human_edit',
      text: { title: '위젯', body: stale.proposal?.body },
      reviewedBy: 'Ada',
      reviewedAt: NOW,
    });
    const memory = await new HelpSegmentMemoryRepo(t.db).lookup(
      { workspaceId, projectId, locale: 'ko' },
      segmentsOf('Widget', EDITED).map(({ hash }) => hash),
    );
    expect(memory.filter(entry => entry.origin === 'human').map(entry => entry.text)).toContain('KO New line.');
    const entries = await audited();
    expect(entries.map(entry => [entry.action, entry.actor])).toEqual([
      ['help.translation.reviewed', reviewerId],
      ['help.translation.proposal_accepted', authorId],
    ]);

    // The same draft can't be accepted twice: it's gone.
    await expect(
      help.helpTranslations.acceptProposal(workspaceId, projectId, authorId, {
        articleId: article.id,
        locale: 'ko',
        proposalRevisionId: stale.proposal?.revisionId ?? '',
      }),
    ).rejects.toBeInstanceOf(HelpNoProposalError);
  });

  it('saves a translation of an article that repeats a paragraph (one memory entry per source text)', async () => {
    const help = domain();
    const article = await translated(help);
    const repeated = '## Tip\n\nRestart the app.\n\n## Tip\n\nRestart the app.';
    await republish(help, article.id, repeated);

    await help.helpTranslations.saveTranslation(workspaceId, projectId, reviewerId, {
      articleId: article.id,
      locale: 'ko',
      title: '위젯',
      body: '## 팁\n\n앱을 다시 시작하세요.\n\n## 팁\n\n앱을 다시 시작하세요.',
    });
    const memory = await new HelpSegmentMemoryRepo(t.db).lookup(
      { workspaceId, projectId, locale: 'ko' },
      segmentsOf('Widget', repeated).map(({ hash }) => hash),
      ['human'],
    );

    expect(new Set(memory.map(entry => entry.text))).toEqual(new Set(['앱을 다시 시작하세요.', '위젯', '팁']));
    expect(memory).toHaveLength(3);
  });

  it('refuses a draft that is not the article’s current one', async () => {
    const help = domain();
    const article = await translated(help);
    const { text } = await help.helpTranslations.review(workspaceId, projectId, article.id, 'ko');
    const saved = await help.helpTranslations.saveTranslation(workspaceId, projectId, reviewerId, {
      articleId: article.id,
      locale: 'ko',
      title: text?.title ?? '',
      body: text?.body ?? '',
    });

    await expect(
      help.helpTranslations.acceptProposal(workspaceId, projectId, reviewerId, {
        articleId: article.id,
        locale: 'ko',
        proposalRevisionId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(HelpNoProposalError);
    expect(saved.locales[0]).toMatchObject({ state: 'reviewed', hasProposal: false });
  });

  it('reads and changes only the project’s own articles, in the languages it offers', async () => {
    const help = domain();
    const article = await translated(help);
    const otherWorkspace = expectOne(
      await t.db.insert(workspaces).values({ name: 'Other', slug: randomUUID() }).returning(),
    ).id;
    const other = await createProjectDomain(t.db).projects.create(otherWorkspace, { name: 'Other', handle: 'other' });
    await help.helpSites.enable(otherWorkspace, other.id, authorId, {
      slug: 'other',
      sourceLocale: 'en',
      locales: ['ko'],
    });
    const input = { articleId: article.id, locale: 'ko', title: 'x', body: 'x' } as const;

    await expect(help.helpTranslations.review(otherWorkspace, other.id, article.id, 'ko')).rejects.toBeInstanceOf(
      HelpNodeNotFoundError,
    );
    await expect(
      help.helpTranslations.saveTranslation(otherWorkspace, other.id, reviewerId, input),
    ).rejects.toBeInstanceOf(HelpNodeNotFoundError);
    await expect(
      help.helpTranslations.retranslate(otherWorkspace, other.id, reviewerId, { articleId: article.id, locale: 'ko' }),
    ).rejects.toBeInstanceOf(HelpNodeNotFoundError);
    await expect(help.helpTranslations.review(workspaceId, projectId, article.id, 'ja')).rejects.toBeInstanceOf(
      HelpLocaleNotOfferedError,
    );
    expect(await audited()).toEqual([]);
  });
});
