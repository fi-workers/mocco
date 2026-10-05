import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HelpIndexNow, indexNowKey } from '@backend/domain/helpcenter/indexnow';
import { HttpIndexNowSender } from '@backend/domain/helpcenter/indexnow-http';
import { HelpJobKinds } from '@backend/domain/helpcenter/jobs';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { IndexNowSender } from '@backend/domain/helpcenter/indexnow';

describe('IndexNow (pglite)', () => {
  let t: TestDb;
  let workspaceId: string;
  let projectId: string;
  let authorId: string;
  let enqueued: { kind: string; payload: unknown; dedupeKey: string | undefined }[];

  const domain = (isIndexNowOn: boolean) =>
    createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      indexNow: isIndexNowOn,
      queue: {
        enqueue: async (job, payload, options) => {
          enqueued.push({ kind: job.kind, payload, dedupeKey: options?.dedupeKey });
          return await Promise.resolve({ job: { id: randomUUID() } as never, created: true });
        },
        kick: () => {},
      },
    });

  /** A Korean site offered in English, with one published article. */
  const publish = async (isIndexNowOn: boolean) => {
    const help = domain(isIndexNowOn);
    await help.helpSites.enable(workspaceId, projectId, authorId, { slug: 'syt', sourceLocale: 'ko', locales: ['en'] });
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
    await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, {
      articleId: article.id,
      title: 'Widget',
      body: 'Tap.',
    });
    await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
    return article;
  };

  beforeEach(async () => {
    t = await createTestDb();
    enqueued = [];
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    authorId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'SYT', handle: 'syt' });
    projectId = project.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('queues one submission per article after a public change, only when IndexNow is on', async () => {
    const article = await publish(true);

    expect(enqueued.filter(job => job.kind === HelpJobKinds.indexNow)).toEqual([
      {
        kind: HelpJobKinds.indexNow,
        payload: { workspaceId, projectId, shortId: article.shortId, slug: 'widget' },
        dedupeKey: `${projectId}:${article.shortId}`,
      },
    ]);
  });

  it('queues nothing when IndexNow is off', async () => {
    await publish(false);

    expect(enqueued.filter(job => job.kind === HelpJobKinds.indexNow)).toEqual([]);
  });

  it("submits the article's and homes' URLs on the site's origin with the site's key", async () => {
    const article = await publish(false);
    const submissions: Parameters<IndexNowSender['submit']>[0][] = [];
    const indexNow = new HelpIndexNow({
      db: t.db,
      secret: 'secret',
      originOf: slug => `https://help.${slug}.app`,
      sender: {
        submit: async submission => {
          submissions.push(submission);
          await Promise.resolve();
        },
      },
    });

    await indexNow.submitArticle(workspaceId, projectId, { shortId: article.shortId, slug: 'widget' });

    expect(submissions).toEqual([
      {
        host: 'help.syt.app',
        key: indexNowKey('secret', 'syt'),
        keyLocation: 'https://help.syt.app/indexnow.txt',
        urls: [
          'https://help.syt.app/ko',
          'https://help.syt.app/en',
          `https://help.syt.app/ko/articles/${article.shortId}-widget`,
          `https://help.syt.app/en/articles/${article.shortId}-widget`,
        ],
      },
    ]);
    expect(indexNowKey('secret', 'syt')).toMatch(/^[0-9a-f]{32}$/u);
    expect(indexNowKey('secret', 'other')).not.toBe(indexNowKey('secret', 'syt'));
  });
});

describe('HttpIndexNowSender', () => {
  it('posts the IndexNow JSON shape and throws on a refusal so the job retries', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const sender = (status: number) =>
      new HttpIndexNowSender({
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return await Promise.resolve(new Response(null, { status }));
        },
      });
    const submission = {
      host: 'h.test',
      key: 'k',
      keyLocation: 'https://h.test/indexnow.txt',
      urls: ['https://h.test/a'],
    };

    await sender(202).submit(submission);
    await expect(sender(422).submit(submission)).rejects.toThrow('IndexNow answered 422');

    expect(calls[0]).toEqual({
      url: 'https://api.indexnow.org/indexnow',
      body: { host: 'h.test', key: 'k', keyLocation: 'https://h.test/indexnow.txt', urlList: ['https://h.test/a'] },
    });
  });
});
