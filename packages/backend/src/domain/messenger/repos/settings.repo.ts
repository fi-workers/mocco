import { and, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { MessengerCategory } from '@mocco/common/messenger';

const s = schema.messengerSettings;

/** Data access for mocco_messenger_settings. Scoped by workspace and project. */
export class MessengerSettingsRepo {
  constructor(private readonly db: Db) {}

  async find(workspaceId: string, projectId: string) {
    const [row] = await this.db
      .select()
      .from(s)
      .where(and(eq(s.workspaceId, workspaceId), eq(s.projectId, projectId)));
    return row;
  }

  /** Insert, or undefined when the project already has settings. */
  async insert(row: typeof s.$inferInsert) {
    const [inserted] = await this.db.insert(s).values(row).onConflictDoNothing().returning();
    return inserted;
  }

  async update(
    workspaceId: string,
    projectId: string,
    values: { identitySecretSealed?: string; categories?: MessengerCategory[]; allowGuests?: boolean },
  ) {
    return expectOne(
      await this.db
        .update(s)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(s.workspaceId, workspaceId), eq(s.projectId, projectId)))
        .returning(),
    );
  }
}
