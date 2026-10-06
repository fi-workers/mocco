// Round-robin assignment (#204) on pglite: new conversations go to the inbox's available
// members in turn, under the project's advisory lock, skipping anyone away or no longer
// in the workspace.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { InboxMemberNotFoundError, NotWorkspaceMemberError } from '@backend/domain/messenger/errors';
import { userHashOf } from '@backend/domain/messenger/identity';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  members,
  messengerConversations,
  messengerInboxMembers,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { MessengerDomain } from '@backend/domain/messenger/compose';
import type { ContactPrincipal } from '@backend/domain/messenger/ContactMessengerService';

describe('messenger round robin (pglite)', () => {
  let t: TestDb;
  let messenger: MessengerDomain;
  let workspaceId: string;
  let projectId: string;
  let principal: ContactPrincipal;
  let ada: string;
  let bo: string;
  let cy: string;

  const teammate = async (name: string) => {
    const user = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name })
        .returning(),
    );
    await t.db.insert(members).values({ organizationId: workspaceId, userId: user.id, role: 'member' });
    return user.id;
  };

  /** A new conversation's assignee (null when no one was available). */
  const start = async () => {
    const conversation = await messenger.contactMessenger.startConversation(principal, {
      body: 'The widget stopped updating',
      clientMessageId: randomUUID(),
    });
    const row = expectOne(
      await t.db.select().from(messengerConversations).where(eq(messengerConversations.id, conversation.id)),
    );
    return row.assigneeUserId;
  };

  const add = async (...userIds: string[]) => {
    // One at a time: the order people join is the order their first turns come in.
    // eslint-disable-next-line no-restricted-syntax -- sequential on purpose
    for (const userId of userIds) {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose
      await messenger.inbox.addMember(workspaceId, projectId, ada, userId);
    }
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    // A clock that moves, so members who join one after another have distinct join times.
    let tick = Date.parse('2026-10-06T09:00:00Z');
    const now = () => {
      tick += 1000;
      return new Date(tick);
    };
    messenger = createMessengerDomain(t.db, { audit, box: () => box, now });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    ada = await teammate('Ada');
    bo = await teammate('Bo');
    cy = await teammate('Cy');
    const { projects } = createProjectDomain(t.db);
    const project = await projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    const { identitySecret } = await messenger.messengerSettings.enable(workspaceId, projectId, ada);
    const session = await messenger.contactMessenger.createSession(
      { workspaceId, projectId },
      { userId: 'u1', userHash: userHashOf(identitySecret, 'u1') },
    );
    const found = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (found === undefined) {
      throw new Error('no session');
    }
    principal = found;
  });
  afterEach(async () => {
    await t.close();
  });

  it('leaves a conversation unassigned while the inbox has no available member', async () => {
    expect(await start()).toBeNull();
    await add(ada);
    await messenger.inbox.setAvailable(workspaceId, projectId, { userId: ada, available: false });
    expect(await start()).toBeNull();
  });

  it('gives new conversations to each member in turn, in the order they joined', async () => {
    await add(ada, bo, cy);
    const assignees = [await start(), await start(), await start(), await start(), await start()];
    expect(assignees).toEqual([ada, bo, cy, ada, bo]);
  });

  it('skips someone who is away, and gives them the next one when they are back', async () => {
    await add(ada, bo, cy);
    await messenger.inbox.setAvailable(workspaceId, projectId, { userId: bo, available: false });
    expect([await start(), await start(), await start()]).toEqual([ada, cy, ada]);
    await messenger.inbox.setAvailable(workspaceId, projectId, { userId: bo, available: true });
    // Bo's last turn is the oldest, so the next conversation is theirs.
    expect([await start(), await start()]).toEqual([bo, cy]);
  });

  it('assigns concurrent new conversations once each, sharing them evenly', async () => {
    await add(ada, bo, cy);
    const assignees = await Promise.all(Array.from({ length: 9 }, async () => await start()));
    const counts = new Map<string | null, number>();
    // eslint-disable-next-line no-restricted-syntax -- a tally
    for (const assignee of assignees) {
      counts.set(assignee, (counts.get(assignee) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ [ada]: 3, [bo]: 3, [cy]: 3 });
    // Nine turns were taken, none twice: the members hold the last three.
    const turns = await t.db
      .select({ turn: messengerInboxMembers.lastTurn })
      .from(messengerInboxMembers)
      .where(eq(messengerInboxMembers.projectId, projectId));
    expect(turns.map(row => row.turn).toSorted((a, b) => a - b)).toEqual([7, 8, 9]);
  });

  it('skips and hides someone who left the workspace', async () => {
    await add(ada, bo);
    await t.db.delete(members).where(and(eq(members.organizationId, workspaceId), eq(members.userId, bo)));
    expect([await start(), await start()]).toEqual([ada, ada]);
    const listed = await messenger.inbox.members(workspaceId, projectId);
    expect(listed.map(member => member.userId)).toEqual([ada]);
  });

  it('only takes workspace members, and audits who joins and leaves', async () => {
    const outsider = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@elsewhere.test`, name: 'Eve' })
        .returning(),
    ).id;
    await expect(messenger.inbox.addMember(workspaceId, projectId, ada, outsider)).rejects.toBeInstanceOf(
      NotWorkspaceMemberError,
    );
    await add(bo, bo);
    await messenger.inbox.removeMember(workspaceId, projectId, ada, bo);
    await expect(messenger.inbox.removeMember(workspaceId, projectId, ada, bo)).rejects.toBeInstanceOf(
      InboxMemberNotFoundError,
    );
    await expect(
      messenger.inbox.setAvailable(workspaceId, projectId, { userId: bo, available: false }),
    ).rejects.toBeInstanceOf(InboxMemberNotFoundError);
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId));
    expect(
      entries
        .filter(entry => entry.action.startsWith('messenger.inbox_member'))
        .map(entry => [entry.action, entry.payload]),
    ).toEqual([
      [AuditActions.messengerInboxMemberAdded, { userId: bo }],
      [AuditActions.messengerInboxMemberRemoved, { userId: bo }],
    ]);
  });

  it('shows the assignee in the inbox list and the conversation', async () => {
    await add(cy);
    await start();
    const [listed] = await messenger.inbox.list(workspaceId, projectId, ada, { status: 'open' });
    expect(listed?.assignee).toEqual({ userId: cy, name: 'Cy' });
    const opened = await messenger.inbox.get(workspaceId, projectId, listed?.id ?? '');
    expect(opened.assignee).toEqual({ userId: cy, name: 'Cy' });
  });
});
