// The customer guide sets: one folder per product area under docs/customer/, served at
// /docs/<set>/<page>. Kept free of node:fs so the guide page can import the labels.
import { z } from 'zod';

export const GuideSets = {
  notifications: 'notifications',
  ota: 'ota',
  flags: 'flags',
} as const;
export type GuideSet = (typeof GuideSets)[keyof typeof GuideSets];
export const guideSetSchema = z.enum([GuideSets.notifications, GuideSets.ota, GuideSets.flags]);

/** The side-nav heading of each set. */
export const guideSetLabels: Record<GuideSet, string> = {
  [GuideSets.notifications]: 'Notifications',
  [GuideSets.ota]: 'OTA and force update',
  [GuideSets.flags]: 'Feature flags',
};
