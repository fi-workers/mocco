import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ExecutorIds } from '@mocco/common/execution';
import { HELP_IMAGE_MAX_BYTES } from '@mocco/common/help';
import { Products } from '@mocco/common/project';
import { ObjectStatuses, Visibilities } from '@mocco/common/storage';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createTestProvider } from '@backend/domain/auth/testing/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { RoleService } from '@backend/domain/governance/RoleService';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { HelpImageNotAnImageError } from '@backend/domain/helpcenter/errors';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { StorageContentTypeNotAllowedError, StorageObjectTooLargeError } from '@backend/domain/storage/errors';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { objects } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createStorageRoutes } from '@backend/transport/ext/storage';
import { appRouter } from '@backend/transport/trpc/root';
import { contextServices } from '@backend/transport/trpc/testing/context-services';

const BASE = 'https://storage.test/api/ext/internal/storage';
/** The first bytes of a PNG, padded: enough for the signature check. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

describe('help router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;
  let root: string;
  let storage: StorageService;
  let storageApp: Hono;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = await createTestProvider(t.db);
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
    root = await mkdtemp(path.join(tmpdir(), 'mocco-help-images-'));
    const signer = new StorageUrlSigner('help-signing-key');
    const store = new FilesystemObjectStore({ root, baseUrl: BASE, signer });
    storage = new StorageService({ objects: new ObjectRepo(t.db), store });
    storageApp = new Hono().basePath('/api/ext').route('/', createStorageRoutes({ store, signer }));
  });
  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  const makeAudit = (): AuditService => new AuditService({ audit: new AuditRepo(t.db) });

  const makeRuns = (): RunService =>
    new RunService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      audit: makeAudit(),
      waitUntil: () => {
        /* help tests don't exercise the run loop */
      },
    });

  const signedInCaller = async (email: string) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = makeRuns();
    const roles = new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) });
    const gates = new GateService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
      audit: makeAudit(),
    });
    const grants = new GrantService({ grants: new CredentialGrantRepo(t.db) });
    const ctx = {
      ...contextServices(t.db),
      ...createHelpDomain(t.db, { audit: makeAudit(), storage, feedbackSecret: () => 'test-feedback-secret' }),
      auth,
      workspace,
      runs,
      roles,
      gates,
      grants,
      audit: makeAudit(),
      session,
      headers,
    };
    return { api: appRouter.createCaller(ctx), ctx, userId: session?.user.id ?? '' };
  };

  /** A workspace with the help center on and a project with a help site. */
  const setup = async (email: string, slug: string) => {
    const owner = await signedInCaller(email);
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    await owner.api.product.enable({ workspaceId: ws.id, product: Products.helpcenter });
    const { project } = await owner.api.project.create({ workspaceId: ws.id, name: 'Acme', handle: 'acme' });
    const scope = { workspaceId: ws.id, projectId: project.id };
    await owner.api.help.enable({ ...scope, slug, sourceLocale: 'en', locales: [] });
    return { ...owner, scope };
  };

  const put = async (
    upload: { url: string; method: string; headers: Record<string, string> },
    body: Uint8Array<ArrayBuffer>,
  ) => await storageApp.fetch(new Request(upload.url, { method: upload.method, headers: upload.headers, body }));

  const reserve = async (
    api: Awaited<ReturnType<typeof setup>>['api'],
    scope: { workspaceId: string; projectId: string },
  ) => {
    const reserved = await api.help.createImageUpload({
      ...scope,
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      filename: 'Screenshot 2026-10-05.png',
    });
    if ('url' in reserved) {
      throw new Error('expected a new upload');
    }
    return reserved;
  };

  describe('helpfulness', () => {
    it('shows an article’s answers from the last 30 days to the project, and to no one else', async () => {
      const owner = await setup('owner@example.com', 'acme');
      const collection = await owner.api.help.createCollection({ ...owner.scope, title: 'Start', slug: 'start' });
      const section = await owner.api.help.createSection({
        ...owner.scope,
        collectionId: collection.id,
        title: 'Basics',
      });
      const article = await owner.api.help.createArticle({ ...owner.scope, sectionId: section.id, title: 'Widgets' });
      await owner.api.help.saveDraft({ ...owner.scope, articleId: article.id, title: 'Widgets', body: 'Long-press.' });
      await owner.api.help.publish({ ...owner.scope, articleId: article.id });
      const vote = async (isHelpful: boolean, visitorId: string, comment?: string) =>
        await owner.ctx.helpFeedback.recordInProject(
          owner.scope.workspaceId,
          owner.scope.projectId,
          article.shortId,
          { helpful: isHelpful, ...(comment !== undefined && { comment }) },
          { visitorId },
        );
      await vote(true, 'visitor-aaaa');
      await vote(true, 'visitor-bbbb', 'Thanks!');
      await vote(false, 'visitor-cccc', 'Missing Android steps');
      const intruder = await setup('intruder@example.com', 'intruder');

      const seen = await owner.api.help.helpfulness({ ...owner.scope, articleId: article.id });

      expect(seen).toMatchObject({ days: 30, helpful: 2, notHelpful: 1 });
      expect(new Set(seen.comments.map(entry => entry.comment))).toEqual(new Set(['Missing Android steps', 'Thanks!']));
      // Another workspace's member, with the owner's ids or their own project's.
      await expect(intruder.api.help.helpfulness({ ...owner.scope, articleId: article.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(intruder.api.help.helpfulness({ ...intruder.scope, articleId: article.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('translations dashboard', () => {
    it('lists published articles in the tree’s order, paged, with counts, and only to the project', async () => {
      const owner = await setup('owner@example.com', 'acme');
      await owner.api.help.updateSite({ ...owner.scope, slug: 'acme', sourceLocale: 'en', locales: ['ko', 'ja'] });
      const first = await owner.api.help.createCollection({ ...owner.scope, title: 'Start', slug: 'start' });
      const second = await owner.api.help.createCollection({ ...owner.scope, title: 'Guides', slug: 'guides' });
      const later = await owner.api.help.createSection({ ...owner.scope, collectionId: second.id, title: 'Later' });
      const sooner = await owner.api.help.createSection({ ...owner.scope, collectionId: first.id, title: 'Sooner' });
      const publish = async (sectionId: string, title: string) => {
        const article = await owner.api.help.createArticle({ ...owner.scope, sectionId, title });
        await owner.api.help.saveDraft({ ...owner.scope, articleId: article.id, title, body: `${title}.` });
        await owner.api.help.publish({ ...owner.scope, articleId: article.id });
        return article;
      };
      // Written out of order: the grid follows collections, then sections, then articles.
      const guide = await publish(later.id, 'Guide');
      const intro = await publish(sooner.id, 'Intro');
      const unpublished = await owner.api.help.createArticle({ ...owner.scope, sectionId: sooner.id, title: 'Draft' });
      await owner.api.help.saveDraft({ ...owner.scope, articleId: unpublished.id, title: 'Draft', body: 'Soon.' });
      await owner.api.help.saveTranslation({
        ...owner.scope,
        articleId: intro.id,
        locale: 'ko',
        title: '소개',
        body: '소개.',
      });
      const intruder = await setup('intruder@example.com', 'intruder');

      const grid = await owner.api.help.translationGrid({ ...owner.scope, limit: 1 });
      const rest = await owner.api.help.translationGrid({ ...owner.scope, offset: 1 });
      const korean = await owner.api.help.translationGrid({ ...owner.scope, locales: ['ko'], filter: 'attention' });

      expect(grid).toMatchObject({
        sourceLocale: 'en',
        locales: ['ko', 'ja'],
        total: 2,
        nextOffset: 1,
        counts: [
          { locale: 'ko', articles: 2, reviewed: 1, notTranslated: 1 },
          { locale: 'ja', articles: 2, notTranslated: 2 },
        ],
        articles: [
          {
            id: intro.id,
            title: 'Intro',
            collection: 'Start',
            section: 'Sooner',
            languages: [
              { locale: 'ko', state: 'reviewed', isStale: false },
              { locale: 'ja', state: null },
            ],
          },
        ],
      });
      expect([rest.articles.map(article => article.id), rest.nextOffset]).toEqual([[guide.id], null]);
      expect(korean.articles.map(article => article.id)).toEqual([guide.id]);
      await expect(owner.api.help.translationGrid({ ...owner.scope, locales: ['fr'] })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(intruder.api.help.translationGrid(owner.scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        intruder.api.help.translationGrid({
          workspaceId: intruder.scope.workspaceId,
          projectId: owner.scope.projectId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('translation review', () => {
    it('reviews as the signed-in member, confirms replacing a reviewed text, and is closed to other workspaces', async () => {
      const owner = await setup('owner@example.com', 'acme');
      await owner.api.help.updateSite({ ...owner.scope, slug: 'acme', sourceLocale: 'en', locales: ['ko'] });
      const collection = await owner.api.help.createCollection({ ...owner.scope, title: 'Start', slug: 'start' });
      const section = await owner.api.help.createSection({ ...owner.scope, collectionId: collection.id, title: 'B' });
      const article = await owner.api.help.createArticle({ ...owner.scope, sectionId: section.id, title: 'Widgets' });
      await owner.api.help.saveDraft({ ...owner.scope, articleId: article.id, title: 'Widgets', body: 'Long-press.' });
      await owner.api.help.publish({ ...owner.scope, articleId: article.id });
      const ko = { ...owner.scope, articleId: article.id, locale: 'ko' } as const;
      const intruder = await setup('intruder@example.com', 'intruder');
      // Offered in the intruder's site too, so only the article's project keeps it out.
      await intruder.api.help.updateSite({ ...intruder.scope, slug: 'intruder', sourceLocale: 'en', locales: ['ko'] });

      await owner.api.help.saveTranslation({ ...ko, title: '위젯', body: '길게 누르세요.' });
      const review = await owner.api.help.translationReview(ko);

      expect(review).toMatchObject({ state: 'reviewed', reviewedBy: 'fixture-user', text: { title: '위젯' } });
      await expect(owner.api.help.retranslate(ko)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(owner.api.help.retranslate({ ...ko, confirm: true })).resolves.toBeDefined();
      await expect(
        owner.api.help.acceptProposal({ ...ko, proposalRevisionId: '00000000-0000-4000-8000-000000000000' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Another workspace's member, with the owner's ids or their own project's.
      await expect(intruder.api.help.translationReview(ko)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(intruder.api.help.saveTranslation({ ...ko, title: 'x', body: 'x' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        intruder.api.help.retranslate({ ...intruder.scope, articleId: article.id, locale: 'ko', confirm: true }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        intruder.api.help.acceptProposal({
          ...intruder.scope,
          articleId: article.id,
          locale: 'ko',
          proposalRevisionId: '00000000-0000-4000-8000-000000000000',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('article images', () => {
    it('uploads a pasted PNG as a public help center object and returns its public URL', async () => {
      const { api, scope } = await setup('owner@example.com', 'acme');

      const { objectId, upload } = await reserve(api, scope);
      const uploaded = await put(upload, PNG);
      expect(uploaded.status).toBe(200);
      const { url } = await api.help.completeImage({ ...scope, objectId });

      expect(url).toBe(
        `${BASE}/pub/w/${scope.workspaceId}/p/${scope.projectId}/helpcenter/${objectId}/screenshot-2026-10-05.png`,
      );
      const [row] = await t.db.select().from(objects).where(eq(objects.id, objectId));
      expect(row).toMatchObject({
        status: ObjectStatuses.ready,
        product: Products.helpcenter,
        projectId: scope.projectId,
        visibility: Visibilities.public,
      });
      // The public URL serves the bytes without a signature.
      const served = await storageApp.fetch(new Request(url));
      const servedBytes = await served.arrayBuffer();
      expect(new Uint8Array(servedBytes)).toEqual(PNG);
    });

    it('refuses anything but PNG, JPEG, WebP and GIF, and anything over 10 MB, before reserving', async () => {
      const { api, ctx, scope, userId } = await setup('owner@example.com', 'acme');
      const image = { ...scope, filename: 'a', sizeBytes: 10 };

      await expect(
        api.help.createImageUpload({ ...image, contentType: 'image/svg+xml' as never }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        api.help.createImageUpload({ ...image, contentType: 'application/pdf' as never }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        api.help.createImageUpload({ ...image, contentType: 'image/png', sizeBytes: HELP_IMAGE_MAX_BYTES + 1 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // The storage policy refuses them too, below the API's input check.
      await expect(
        ctx.helpImages.createImageUpload(scope.workspaceId, scope.projectId, userId, {
          ...image,
          contentType: 'text/html' as never,
        }),
      ).rejects.toBeInstanceOf(StorageContentTypeNotAllowedError);
      await expect(
        ctx.helpImages.createImageUpload(scope.workspaceId, scope.projectId, userId, {
          ...image,
          contentType: 'image/png',
          sizeBytes: HELP_IMAGE_MAX_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(StorageObjectTooLargeError);
      expect(await t.db.select().from(objects)).toEqual([]);
    });

    it('accepts exactly 10 MB', async () => {
      const { api, scope } = await setup('owner@example.com', 'acme');

      const reserved = await api.help.createImageUpload({
        ...scope,
        contentType: 'image/png',
        sizeBytes: HELP_IMAGE_MAX_BYTES,
        filename: 'big.png',
      });

      expect(reserved).toHaveProperty('objectId');
    });

    it('deletes and refuses an upload whose bytes are not the declared image', async () => {
      const { api, scope } = await setup('owner@example.com', 'acme');
      const html = new TextEncoder().encode('<script>alert(1)</script>');
      const reserved = await api.help.createImageUpload({
        ...scope,
        contentType: 'image/png',
        sizeBytes: html.byteLength,
        filename: 'not-really.png',
      });
      if ('url' in reserved) {
        throw new Error('expected a new upload');
      }
      const uploaded = await put(reserved.upload, html);
      expect(uploaded.status).toBe(200);

      await expect(api.help.completeImage({ ...scope, objectId: reserved.objectId })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: expect.any(HelpImageNotAnImageError),
      });
      const [row] = await t.db.select().from(objects).where(eq(objects.id, reserved.objectId));
      expect(row?.status).toBe(ObjectStatuses.deleted);
      expect(await storage.store.head(row?.key ?? '')).toBeNull();
    });

    it("can't complete another project's upload, another product's object, or another workspace's image", async () => {
      const owner = await setup('owner@example.com', 'acme');
      const { project: other } = await owner.api.project.create({
        workspaceId: owner.scope.workspaceId,
        name: 'Other',
        handle: 'other',
      });
      const otherScope = { workspaceId: owner.scope.workspaceId, projectId: other.id };
      await owner.api.help.enable({ ...otherScope, slug: 'other', sourceLocale: 'en', locales: [] });
      const theirs = await reserve(owner.api, otherScope);
      await put(theirs.upload, PNG);
      // A private messenger attachment in the same workspace.
      const { object: attachment } = await storage.beginUpload({
        workspaceId: owner.scope.workspaceId,
        projectId: owner.scope.projectId,
        product: Products.messenger,
        filename: 'private.png',
        contentType: 'image/png',
        sizeBytes: PNG.byteLength,
        visibility: Visibilities.private,
      });
      const intruder = await setup('intruder@example.com', 'intruder');
      const mine = await reserve(owner.api, owner.scope);

      await expect(owner.api.help.completeImage({ ...owner.scope, objectId: theirs.objectId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(owner.api.help.completeImage({ ...owner.scope, objectId: attachment.id })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        intruder.api.help.completeImage({ ...intruder.scope, objectId: mine.objectId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        intruder.api.help.createImageUpload({
          ...owner.scope,
          contentType: 'image/png',
          sizeBytes: 10,
          filename: 'a.png',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const rows = await t.db.select({ id: objects.id, status: objects.status }).from(objects);
      expect(rows.filter(row => row.status === ObjectStatuses.ready)).toEqual([]);
    });
  });
});
