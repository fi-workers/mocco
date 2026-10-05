// Contract (#216): the messenger's composition can call the help center's search
// in-process, so suggesting articles for an inquiry needs no HTTP hop and no key. What a
// contact's conversation knows (its workspace, project and the text being written) is
// all the search takes, and it only ever finds that project's published articles.
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { userHashOf } from '@backend/domain/messenger/identity';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { MessengerDomain } from '@backend/domain/messenger/compose';

/** What the messenger would take to suggest articles: the help center's in-process search. */
type ArticleSuggestions = Pick<HelpPublicReadService, 'searchInProject'>;

describe('messenger → help center search (contract, pglite)', () => {
  let t: TestDb;
  let help: HelpDomain;
  let messenger: MessengerDomain;
  let workspaceId: string;
  let userId: string;
  let projects: ReturnType<typeof createProjectDomain>['projects'];

  /** A contact of `projectId` who starts a conversation with `body`; its contact row. */
  const inquiry = async (projectId: string, body: string) => {
    const { identitySecret } = await messenger.messengerSettings.enable(workspaceId, projectId, userId);
    const session = await messenger.contactMessenger.createSession(
      { workspaceId, projectId },
      { userId: 'u1', userHash: userHashOf(identitySecret, 'u1') },
    );
    const principal = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('no session');
    }
    await messenger.contactMessenger.startConversation(principal, { body, clientMessageId: randomUUID() });
    return principal.contact;
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    // Both domains composed over one db, as the production roots compose them.
    help = createHelpDomain(t.db, { audit });
    messenger = createMessengerDomain(t.db, { audit, box: () => box });
    ({ projects } = createProjectDomain(t.db));
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('suggests the project’s published articles for what a contact wrote', async () => {
    const project = await projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    const other = await projects.create(workspaceId, { name: 'Other', handle: 'other' });
    await help.helpSites.enable(workspaceId, project.id, userId, { slug: 'syt', sourceLocale: 'ko', locales: [] });
    const collection = await help.helpAuthoring.createCollection(workspaceId, project.id, {
      title: '시작',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, project.id, {
      collectionId: collection.id,
      title: '기본',
    });
    const article = await help.helpAuthoring.createArticle(workspaceId, project.id, userId, {
      sectionId: section.id,
      title: '위젯 추가하기',
      slug: 'widget',
    });
    await help.helpAuthoring.saveDraft(workspaceId, project.id, userId, {
      articleId: article.id,
      title: '위젯 추가하기',
      body: '홈 화면을 길게 누르세요.',
    });
    await help.helpAuthoring.publish(workspaceId, project.id, userId, article.id);
    const suggestions: ArticleSuggestions = help.helpPublic;
    const text = '위젯이 화면에 안 보여요';

    const contact = await inquiry(project.id, text);
    const found = await suggestions.searchInProject(contact.workspaceId, contact.projectId, 'ko', text, 3, 'any');
    // Another project's contact never sees this help center (that project has none).
    const otherContact = await inquiry(other.id, text);
    const elsewhere = suggestions.searchInProject(
      otherContact.workspaceId,
      otherContact.projectId,
      'ko',
      text,
      3,
      'any',
    );

    expectTypeOf(help.helpPublic).toExtend<ArticleSuggestions>();
    expect(found.hits.map(hit => hit.path)).toEqual([`/ko/articles/${article.shortId}-widget`]);
    await expect(elsewhere).rejects.toMatchObject({ name: 'HelpSiteNotFoundError' });
  });
});
