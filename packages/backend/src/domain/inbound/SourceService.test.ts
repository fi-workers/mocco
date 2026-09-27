import { InboundKinds, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InboundSecretNotAcceptedError,
  InboundSecretRequiredError,
  InboundSourceNotFoundError,
} from '@backend/domain/inbound/errors';
import { createInboundHarness, insertWorkspace, TEST_ORIGIN } from '@backend/domain/inbound/testing/harness';
import { SecretBoxError } from '@backend/infra/crypto/errors';
import { inboundReceipts, inboundSources, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const INGEST_URL = new RegExp(String.raw`^${TEST_ORIGIN}/api/ext/inbound/[\w-]{43}$`, 'u');

describe('SourceService on pglite', () => {
  let t: TestDb;
  let workspaceId: string;

  beforeEach(async () => {
    t = await createTestDb();
    workspaceId = await insertWorkspace(t.db, 'acme');
  });
  afterEach(async () => {
    await t.close();
  });

  const storedRow = async () => {
    const [row] = await t.db.select().from(inboundSources);
    if (row === undefined) {
      throw new Error('no source row');
    }
    return row;
  };

  describe('create', () => {
    it.each([InboundKinds.sentry, InboundKinds.vercel])(
      'seals the pasted %s secret (trimmed) under the row id and never returns it',
      async kind => {
        const { sources, box } = createInboundHarness(t.db);

        const created = await sources.create(workspaceId, { kind, name: '  Acme web ', secret: '  pasted-secret \n' });

        expect(created.generatedSecret).toBeNull();
        expect(created.source).toMatchObject({
          kind,
          name: 'Acme web',
          status: InboundSourceStatuses.active,
          hasSecret: true,
          lastReceivedAt: null,
        });
        expect(created.source.ingestUrl).toMatch(INGEST_URL);
        expect(JSON.stringify(created)).not.toContain('pasted-secret');
        const row = await storedRow();
        expect(row.id).toBe(created.source.id);
        expect(box.open(row.secretSealed, `mocco_inbound_sources:${row.id}`)).toBe('pasted-secret');
        // The AAD binds the sealed value to its row: it does not open for another id.
        expect(() => box.open(row.secretSealed, 'mocco_inbound_sources:other')).toThrow(SecretBoxError);
      },
    );

    it.each([InboundKinds.sentry, InboundKinds.vercel])('requires a non-blank secret for %s', async kind => {
      const { sources } = createInboundHarness(t.db);

      await expect(sources.create(workspaceId, { kind, name: 'x' })).rejects.toThrow(InboundSecretRequiredError);
      await expect(sources.create(workspaceId, { kind, name: 'x', secret: ' '.repeat(3) })).rejects.toThrow(
        InboundSecretRequiredError,
      );
      expect(await t.db.select().from(inboundSources)).toHaveLength(0);
    });

    it('generates a GitHub secret (32 bytes hex), returns it once, and refuses a pasted one', async () => {
      const { sources, box } = createInboundHarness(t.db);

      const created = await sources.create(workspaceId, { kind: InboundKinds.github, name: 'repo' });

      expect(created.generatedSecret).toMatch(/^[\da-f]{64}$/u);
      const row = await storedRow();
      expect(box.open(row.secretSealed, `mocco_inbound_sources:${row.id}`)).toBe(created.generatedSecret);
      expect(JSON.stringify(await sources.list(workspaceId))).not.toContain(created.generatedSecret ?? '-');
      await expect(
        sources.create(workspaceId, { kind: InboundKinds.github, name: 'repo', secret: 'mine' }),
      ).rejects.toThrow(InboundSecretNotAcceptedError);
    });

    it('gives every source its own unguessable ingest key', async () => {
      const { sources } = createInboundHarness(t.db);
      const a = await sources.create(workspaceId, { kind: InboundKinds.github, name: 'a' });
      const b = await sources.create(workspaceId, { kind: InboundKinds.github, name: 'b' });

      expect(a.source.ingestUrl).not.toBe(b.source.ingestUrl);
    });
  });

  describe('list, rename, pause, resume, delete', () => {
    it('lists only the workspace’s own sources, without secrets', async () => {
      const { sources } = createInboundHarness(t.db);
      const other = await insertWorkspace(t.db, 'other');
      await sources.create(workspaceId, { kind: InboundKinds.sentry, name: 'mine', secret: 's1' });
      await sources.create(other, { kind: InboundKinds.sentry, name: 'theirs', secret: 's2' });

      const listed = await sources.list(workspaceId);

      expect(listed.map(source => source.name)).toEqual(['mine']);
      expect(Object.keys(listed[0] ?? {})).not.toContain('secretSealed');
      expect(JSON.stringify(listed)).not.toContain('v1.');
    });

    it('renames, pauses and resumes', async () => {
      const { sources } = createInboundHarness(t.db);
      const { source } = await sources.create(workspaceId, { kind: InboundKinds.vercel, name: 'a', secret: 's' });

      const renamed = await sources.rename(workspaceId, source.id, ' b ');
      expect(renamed.name).toBe('b');
      const paused = await sources.pause(workspaceId, source.id);
      expect(paused.status).toBe(InboundSourceStatuses.paused);
      const resumed = await sources.resume(workspaceId, source.id);
      expect(resumed.status).toBe(InboundSourceStatuses.active);
    });

    it('deletes a source with its receipts', async () => {
      const { sources } = createInboundHarness(t.db);
      const { source } = await sources.create(workspaceId, { kind: InboundKinds.vercel, name: 'a', secret: 's' });
      await t.db
        .insert(inboundReceipts)
        .values({ workspaceId, sourceId: source.id, externalId: 'e', outcome: InboundOutcomes.ignored });

      await sources.delete(workspaceId, source.id);

      expect(await t.db.select().from(inboundSources)).toHaveLength(0);
      expect(await t.db.select().from(inboundReceipts)).toHaveLength(0);
    });

    it('cascades sources and receipts with the workspace', async () => {
      const { sources } = createInboundHarness(t.db);
      const { source } = await sources.create(workspaceId, { kind: InboundKinds.vercel, name: 'a', secret: 's' });
      await t.db
        .insert(inboundReceipts)
        .values({ workspaceId, sourceId: source.id, externalId: 'e', outcome: InboundOutcomes.ignored });

      await t.db.delete(workspaces);

      expect(await t.db.select().from(inboundSources)).toHaveLength(0);
      expect(await t.db.select().from(inboundReceipts)).toHaveLength(0);
    });

    it('treats another workspace’s source as not found on every write', async () => {
      const { sources } = createInboundHarness(t.db);
      const other = await insertWorkspace(t.db, 'other');
      const { source } = await sources.create(other, { kind: InboundKinds.sentry, name: 'theirs', secret: 's' });

      await expect(sources.rename(workspaceId, source.id, 'x')).rejects.toThrow(InboundSourceNotFoundError);
      await expect(sources.pause(workspaceId, source.id)).rejects.toThrow(InboundSourceNotFoundError);
      await expect(sources.resume(workspaceId, source.id)).rejects.toThrow(InboundSourceNotFoundError);
      await expect(sources.rotateSecret(workspaceId, source.id, 'x')).rejects.toThrow(InboundSourceNotFoundError);
      await expect(sources.delete(workspaceId, source.id)).rejects.toThrow(InboundSourceNotFoundError);
      const theirs = await sources.list(other);
      expect(theirs[0]).toMatchObject({ name: 'theirs', status: InboundSourceStatuses.active });
    });
  });

  describe('rotateSecret', () => {
    it('replaces a pasted secret and keeps the ingest URL', async () => {
      const { sources, box } = createInboundHarness(t.db);
      const { source } = await sources.create(workspaceId, { kind: InboundKinds.sentry, name: 'a', secret: 'old' });

      const rotated = await sources.rotateSecret(workspaceId, source.id, ' new ');

      expect(rotated.generatedSecret).toBeNull();
      expect(rotated.source.ingestUrl).toBe(source.ingestUrl);
      const row = await storedRow();
      expect(box.open(row.secretSealed, `mocco_inbound_sources:${row.id}`)).toBe('new');
      await expect(sources.rotateSecret(workspaceId, source.id, undefined)).rejects.toThrow(InboundSecretRequiredError);
    });

    it('generates a new GitHub secret and returns it once', async () => {
      const { sources, box } = createInboundHarness(t.db);
      const created = await sources.create(workspaceId, { kind: InboundKinds.github, name: 'a' });

      const rotated = await sources.rotateSecret(workspaceId, created.source.id, undefined);

      expect(rotated.generatedSecret).toMatch(/^[\da-f]{64}$/u);
      expect(rotated.generatedSecret).not.toBe(created.generatedSecret);
      const row = await storedRow();
      expect(box.open(row.secretSealed, `mocco_inbound_sources:${row.id}`)).toBe(rotated.generatedSecret);
    });
  });
});
