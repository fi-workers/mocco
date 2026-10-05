// The customer guide sets: one folder per product area under docs/customer/, served at
// /docs/<set>/<page>. Kept free of node:fs so the guide page can import the labels.
import { z } from 'zod';

export const GuideSets = {
  start: 'start',
  governance: 'governance',
  notifications: 'notifications',
  ota: 'ota',
  flags: 'flags',
  messenger: 'messenger',
  help: 'help',
  status: 'status',
  mcp: 'mcp',
} as const;
export type GuideSet = (typeof GuideSets)[keyof typeof GuideSets];
export const guideSetSchema = z.enum([
  GuideSets.start,
  GuideSets.governance,
  GuideSets.notifications,
  GuideSets.ota,
  GuideSets.flags,
  GuideSets.messenger,
  GuideSets.help,
  GuideSets.status,
  GuideSets.mcp,
]);

/** The side-nav heading of each set. */
export const guideSetLabels: Record<GuideSet, string> = {
  [GuideSets.start]: 'Getting started',
  [GuideSets.governance]: 'Deploy governance',
  [GuideSets.notifications]: 'Notifications',
  [GuideSets.ota]: 'OTA and force update',
  [GuideSets.flags]: 'Feature flags',
  [GuideSets.messenger]: 'Messenger',
  [GuideSets.help]: 'Help center',
  [GuideSets.status]: 'Status page',
  [GuideSets.mcp]: 'Agents (MCP)',
};
