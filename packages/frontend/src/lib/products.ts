// The product registry: which sections the app shell shows, and for which product.
// Workspace-scoped sections live in the workspace sidebar; project-scoped ones in the
// project sidebar. Each section sits in a group named for the job it does (release,
// support, operate…), so the sidebar stays scannable as products are added. A section
// tied to a product is hidden unless the workspace has it enabled (`product.list`);
// `null` means always shown. Adding a product's screen is one entry here plus its
// page — no layout edits.
import { Products } from '@mocco/common/project';

import { Routes } from '@frontend/lib/routes';

import type { Product } from '@mocco/common/project';

/**
 * The jobs Mocco's products and sections are grouped by, in display order — the one
 * order every list follows (sidebars, Products page, landing): ship it, run it, hear
 * from the people who use it (ADR 0029).
 */
export const SectionGroups = {
  release: 'release',
  operate: 'operate',
  support: 'support',
  platform: 'platform',
  developers: 'developers',
  workspace: 'workspace',
} as const;
export type SectionGroup = (typeof SectionGroups)[keyof typeof SectionGroups];

export const sectionGroupLabels: Readonly<Record<SectionGroup, string>> = {
  [SectionGroups.release]: 'Release',
  [SectionGroups.operate]: 'Operate',
  [SectionGroups.support]: 'Support',
  [SectionGroups.platform]: 'Platform',
  [SectionGroups.developers]: 'Developers',
  [SectionGroups.workspace]: 'Workspace',
};

export const WorkspaceSections = {
  home: 'home',
  deploys: 'deploys',
  projects: 'projects',
  members: 'members',
  access: 'access',
  notifications: 'notifications',
  audit: 'audit',
  products: 'products',
  settings: 'settings',
} as const;
export type WorkspaceSection = (typeof WorkspaceSections)[keyof typeof WorkspaceSections];

export const ProjectSections = {
  overview: 'overview',
  ota: 'ota',
  otaUpdates: 'otaUpdates',
  flags: 'flags',
  inbox: 'inbox',
  help: 'help',
  status: 'status',
  apiKeys: 'apiKeys',
} as const;
export type ProjectSection = (typeof ProjectSections)[keyof typeof ProjectSections];

interface NavEntry<Key, Href> {
  key: Key;
  label: string;
  href: Href;
  /** The product that must be enabled for this section to show; null = always. */
  product: Product | null;
  /** The sidebar group it is listed under; null = above the groups. */
  group: SectionGroup | null;
}

export const workspaceNav: readonly NavEntry<WorkspaceSection, (workspaceId: string) => string>[] = [
  { key: WorkspaceSections.home, label: 'Home', href: Routes.workspaceHome, product: null, group: null },
  { key: WorkspaceSections.projects, label: 'Projects', href: Routes.workspaceProjects, product: null, group: null },
  {
    key: WorkspaceSections.deploys,
    label: 'Deploys',
    href: Routes.workspace,
    product: Products.governance,
    group: SectionGroups.release,
  },
  {
    key: WorkspaceSections.notifications,
    label: 'Notifications',
    href: Routes.workspaceNotifications,
    product: null,
    group: SectionGroups.operate,
  },
  {
    key: WorkspaceSections.audit,
    label: 'Audit',
    href: Routes.workspaceAudit,
    product: null,
    group: SectionGroups.operate,
  },
  {
    key: WorkspaceSections.members,
    label: 'Members',
    href: Routes.workspaceMembers,
    product: null,
    group: SectionGroups.workspace,
  },
  {
    key: WorkspaceSections.access,
    label: 'Access',
    href: Routes.workspaceAccess,
    product: null,
    group: SectionGroups.workspace,
  },
  {
    key: WorkspaceSections.products,
    label: 'Products',
    href: Routes.workspaceProducts,
    product: null,
    group: SectionGroups.workspace,
  },
  {
    key: WorkspaceSections.settings,
    label: 'Settings',
    href: Routes.workspaceSettings,
    product: null,
    group: SectionGroups.workspace,
  },
];

export const projectNav: readonly NavEntry<ProjectSection, (workspaceId: string, projectId: string) => string>[] = [
  { key: ProjectSections.overview, label: 'Overview', href: Routes.project, product: null, group: null },
  {
    key: ProjectSections.ota,
    label: 'Force update',
    href: Routes.projectOta,
    product: Products.ota,
    group: SectionGroups.release,
  },
  {
    key: ProjectSections.otaUpdates,
    label: 'OTA updates',
    href: Routes.projectOtaHosting,
    product: Products.ota,
    group: SectionGroups.release,
  },
  {
    key: ProjectSections.flags,
    label: 'Feature flags',
    href: Routes.projectFlags,
    product: Products.flags,
    group: SectionGroups.release,
  },
  {
    key: ProjectSections.status,
    label: 'Status page',
    href: Routes.projectStatus,
    product: Products.status,
    group: SectionGroups.operate,
  },
  {
    key: ProjectSections.inbox,
    label: 'Inbox',
    href: Routes.projectInbox,
    product: Products.messenger,
    group: SectionGroups.support,
  },
  {
    key: ProjectSections.help,
    label: 'Help center',
    href: Routes.projectHelp,
    product: Products.helpcenter,
    group: SectionGroups.support,
  },
  {
    key: ProjectSections.apiKeys,
    label: 'API keys',
    href: Routes.projectApiKeys,
    product: null,
    group: SectionGroups.developers,
  },
];

/** How each product is presented on the Products page. `available` = it has screens today. */
export const productCatalog: Readonly<
  Record<
    Product,
    {
      label: string;
      description: string;
      available: boolean;
      group: SectionGroup;
      /** The customer guide that starts using it; null until it has one. */
      guide: string | null;
    }
  >
> = {
  [Products.governance]: {
    label: 'Deploy governance',
    description: 'Gates, approvals and credential gating for your pipelines. Always on.',
    available: true,
    group: SectionGroups.release,
    guide: Routes.guide('governance', 'overview'),
  },
  [Products.ota]: {
    label: 'OTA and force update',
    description: 'Minimum and recommended app versions with gated changes, and gated publishing for your OTA tool.',
    available: true,
    group: SectionGroups.release,
    guide: Routes.guide('ota', 'overview'),
  },
  [Products.flags]: {
    label: 'Feature flags',
    description: 'Governed flag changes with OpenFeature SDKs.',
    available: true,
    group: SectionGroups.release,
    guide: Routes.guide('flags', 'quickstart'),
  },
  [Products.status]: {
    label: 'Status page',
    description: 'Uptime monitors, incidents and a public status page.',
    available: true,
    group: SectionGroups.operate,
    guide: Routes.guide('status', 'status-page'),
  },
  [Products.reviews]: {
    label: 'App reviews',
    description: 'Store reviews analyzed and tied to releases.',
    available: false,
    group: SectionGroups.operate,
    guide: null,
  },
  [Products.feedback]: {
    label: 'Feedback board',
    description: 'Public feedback, roadmap and changelog.',
    available: false,
    group: SectionGroups.support,
    guide: null,
  },
  [Products.messenger]: {
    label: 'Messenger',
    description: 'Let your signed-in users contact you from your app, and answer them from one inbox.',
    available: true,
    group: SectionGroups.support,
    guide: Routes.guide('messenger', 'contact-us'),
  },
  [Products.helpcenter]: {
    label: 'Help center',
    description: 'A public help site for your product, written in Markdown and published per language.',
    available: true,
    group: SectionGroups.support,
    guide: Routes.guide('help', 'help-center'),
  },
  [Products.forum]: {
    label: 'Forum',
    description: 'A community forum for your product.',
    available: false,
    group: SectionGroups.support,
    guide: null,
  },
  [Products.links]: {
    label: 'Deep links',
    description: 'Smart links with deferred deep linking.',
    available: false,
    group: SectionGroups.platform,
    guide: null,
  },
  [Products.identity]: {
    label: 'End-user identity',
    description: 'Sign-in for your customers’ users.',
    available: false,
    group: SectionGroups.platform,
    guide: null,
  },
};

/** Entries in sidebar order: the ungrouped ones first, then each group in `SectionGroups` order. */
export function groupEntries<Entry extends { group: SectionGroup | null }>(
  entries: readonly Entry[],
): { group: SectionGroup | null; entries: Entry[] }[] {
  const order: (SectionGroup | null)[] = [null, ...Object.values(SectionGroups)];
  return order
    .map(group => ({ group, entries: entries.filter(entry => entry.group === group) }))
    .filter(section => section.entries.length > 0);
}

/** Keep the entries whose product is enabled (or that need none). */
export function visibleEntries<Entry extends { product: Product | null }>(
  entries: readonly Entry[],
  enabled: readonly Product[],
): Entry[] {
  const on = new Set(enabled);
  return entries.filter(entry => entry.product === null || on.has(entry.product));
}
