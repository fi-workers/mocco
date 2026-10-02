// Erasing a contact (#95, privacy): a hard delete of the contact with every conversation,
// message, attachment and push token they have, and the attachments' bytes. The team
// erases from the inbox; a user erases themselves through /v1 (an app's "delete my
// account"). The audit keeps only that it happened.
import { MessengerAttachmentRepo } from '@backend/domain/messenger/repos/attachment.repo';
import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';

import type { AttachmentStorage } from '@backend/domain/messenger/attachments';
import type { Db } from '@backend/infra/db/types';

export async function eraseContact(
  deps: { db: Db; storage?: AttachmentStorage },
  contact: { id: string; workspaceId: string },
): Promise<void> {
  const objectIds = await new MessengerAttachmentRepo(deps.db).objectIdsForContact(contact.workspaceId, contact.id);
  const { storage } = deps;
  // Bytes first: if this stops halfway, the contact is still there and erasing again finishes.
  if (storage !== undefined) {
    await Promise.all(objectIds.map(async objectId => await storage.delete(contact.workspaceId, objectId)));
  }
  await new MessengerContactRepo(deps.db).delete(contact.workspaceId, contact.id);
}
