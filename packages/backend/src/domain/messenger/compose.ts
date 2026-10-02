// The messenger's services over a db. Pure (no instance imports); instance.ts binds the
// production singletons, tests call it with a pglite db.
import { ContactMessengerService } from '@backend/domain/messenger/ContactMessengerService';
import { InboxService } from '@backend/domain/messenger/InboxService';
import { MessengerSettingsService } from '@backend/domain/messenger/MessengerSettingsService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { AttachmentStorage } from '@backend/domain/messenger/attachments';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type { Db } from '@backend/infra/db/types';

export interface MessengerDomain {
  messengerSettings: MessengerSettingsService;
  contactMessenger: ContactMessengerService;
  inbox: InboxService;
}

export function createMessengerDomain(
  db: Db,
  deps: {
    audit: AuditService;
    box: () => SecretBox;
    storage?: AttachmentStorage;
    events?: EventPublisher;
    appOrigin?: string;
    now?: () => Date;
  },
): MessengerDomain {
  const messengerSettings = new MessengerSettingsService({ db, audit: deps.audit, box: deps.box });
  const contactMessenger = new ContactMessengerService({ db, settings: messengerSettings, ...deps });
  const inbox = new InboxService({
    db,
    audit: deps.audit,
    ...(deps.storage !== undefined && { storage: deps.storage }),
    ...(deps.now !== undefined && { now: deps.now }),
  });
  return { messengerSettings, contactMessenger, inbox };
}
