import { randomBytes, randomUUID } from 'node:crypto';

import { FlagApprovalSubjects } from '@mocco/common/flags';
import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { OtaApprovalSubjects } from '@mocco/common/ota';
import { OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createOtaDomain } from '@backend/domain/ota/instance';
import { OtaAppRepo } from '@backend/domain/ota/repos/ota-app.repo';
import { OtaChannelRepo } from '@backend/domain/ota/repos/ota-channel.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { projectApps, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { GateRequirements } from '@mocco/common/governance';

const gate: GateRequirements = { resume: [{ role: 'release', count: 1 }], prevent_self: false, reason_required: false };

// The approval queue names each request's subject (#421) with one query per owning
// product, however many requests and projects it holds — Home renders it as is.
describe('approval subject labels (pglite)', () => {
  let t: TestDb;
  let approvals: ApprovalService;
  let workspaceId: string;
  const queries: string[] = [];

  beforeEach(async () => {
    t = await createTestDb({
      onQuery: query => {
        queries.push(query);
      },
    });
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const project = createProjectDomain(t.db);
    approvals = createApprovalService(t.db, audit);
    createFlagsDomain(t.db, { audit, approvals });
    const box = new SecretBox([{ id: 'test', key: randomBytes(32) }]);
    createOtaDomain(t.db, {
      publicApiBase: 'https://mocco.test/api/ext/v1',
      projects: project.projects,
      approvals,
      audit,
      secretBox: () => box,
    });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
  });
  afterEach(async () => {
    await t.close();
    queries.length = 0;
  });

  /** A project with a flag environment, an OTA channel and a store app, and a pending
   * request on each. */
  const seedProject = async (handle: string, environmentName: string, channelName: string, storeAppName: string) => {
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: handle, handle });
    const environment = await new FlagEnvironmentRepo(t.db).insert({
      workspaceId,
      projectId: project.id,
      key: 'main',
      name: environmentName,
    });
    const projectApp = expectOne(
      await t.db
        .insert(projectApps)
        .values({ workspaceId, projectId: project.id, platform: AppPlatforms.reactNative, name: 'App' })
        .returning(),
    );
    const app = await new OtaAppRepo(t.db).insert({
      workspaceId,
      projectId: project.id,
      projectAppId: projectApp.id,
      assetBaseUrl: 'https://assets.mocco.test',
    });
    const channel = await new OtaChannelRepo(t.db).insert({ workspaceId, appId: app.id, name: channelName });
    const storeApp = expectOne(
      await t.db
        .insert(projectApps)
        .values({ workspaceId, projectId: project.id, platform: AppPlatforms.ios, name: storeAppName })
        .returning(),
    );
    const open = async (subjectType: string, subjectId: string, action: Record<string, unknown>) =>
      await approvals.request(workspaceId, {
        projectId: project.id,
        kind: ApprovalKinds.preApproval,
        subjectType,
        subjectId,
        action,
        requirements: gate,
        requestedByUserId: null,
      });
    return {
      changeset: await open(FlagApprovalSubjects.changeset, randomUUID(), { environmentId: environment.id }),
      changeGate: await open(FlagApprovalSubjects.changeGate, environment.id, { environmentId: environment.id, gate }),
      channelChange: await open(OtaHostingApprovalSubjects.channelChange, channel.id, { channelId: channel.id }),
      channelPolicy: await open(OtaHostingApprovalSubjects.channelPolicy, channel.id, { channelId: channel.id }),
      versionPolicy: await open(OtaApprovalSubjects.versionPolicy, storeApp.id, { appId: storeApp.id }),
    };
  };

  const listPending = async () => {
    queries.length = 0;
    const listed = await approvals.listLabeled(workspaceId, { state: ApprovalStates.pending });
    return { labels: new Map(listed.map(request => [request.id, request.subjectLabel])), queries: queries.length };
  };

  it('names the environment, channel or app of each request across projects', async () => {
    const qa = await seedProject('qa-app', 'Production', 'production', 'QA App');
    const shop = await seedProject('shop', 'Staging', 'beta', 'Shopper');

    const { labels } = await listPending();

    expect(labels.get(qa.changeset.id)).toBe('Production');
    expect(labels.get(qa.changeGate.id)).toBe('Production');
    expect(labels.get(qa.channelChange.id)).toBe('production channel');
    expect(labels.get(qa.channelPolicy.id)).toBe('production channel');
    expect(labels.get(shop.changeset.id)).toBe('Staging');
    expect(labels.get(shop.channelChange.id)).toBe('beta channel');
    // A minimum or recommended version is about a store app, which the project domain owns.
    expect(labels.get(qa.versionPolicy.id)).toBe('QA App (iOS)');
    expect(labels.get(shop.versionPolicy.id)).toBe('Shopper (iOS)');
  });

  it('takes the same number of queries however many projects the queue spans', async () => {
    await seedProject('qa-app', 'Production', 'production', 'QA App');
    const one = await listPending();
    await seedProject('shop', 'Staging', 'beta', 'Shopper');
    await seedProject('admin', 'Canary', 'internal', 'Admin');
    const three = await listPending();

    expect(three.labels.size).toBe(3 * one.labels.size);
    expect(new Set(three.labels.values()).has(null)).toBe(false);
    // The requests, then one read per labelling product (flag environments, OTA channels,
    // project apps).
    expect(one.queries).toBe(4);
    expect(three.queries).toBe(4);
  });

  it('leaves out a subject from another workspace', async () => {
    const otherWorkspace = expectOne(
      await t.db.insert(workspaces).values({ name: 'Other', slug: randomUUID() }).returning(),
    ).id;
    const otherProject = await createProjectDomain(t.db).projects.create(otherWorkspace, {
      name: 'Other',
      handle: 'other',
    });
    const foreign = await new FlagEnvironmentRepo(t.db).insert({
      workspaceId: otherWorkspace,
      projectId: otherProject.id,
      key: 'production',
      name: 'Production',
    });
    const request = await approvals.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: FlagApprovalSubjects.changeset,
      subjectId: randomUUID(),
      action: { environmentId: foreign.id },
      requirements: gate,
      requestedByUserId: null,
    });
    const foreignApp = expectOne(
      await t.db
        .insert(projectApps)
        .values({ workspaceId: otherWorkspace, projectId: otherProject.id, platform: AppPlatforms.ios, name: 'Other' })
        .returning(),
    );
    const versionPolicy = await approvals.request(workspaceId, {
      kind: ApprovalKinds.preApproval,
      subjectType: OtaApprovalSubjects.versionPolicy,
      subjectId: foreignApp.id,
      action: { appId: foreignApp.id },
      requirements: gate,
      requestedByUserId: null,
    });

    const { labels } = await listPending();

    expect(labels.get(request.id)).toBeNull();
    expect(labels.get(versionPolicy.id)).toBeNull();
  });
});
