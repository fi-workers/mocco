// The product registry: which sections the app shell shows, and for which product.
// Workspace-scoped sections live in the workspace nav; project-scoped ones in the
// project tabs. A section tied to a product is hidden unless the workspace has it
// enabled (`product.list`); `null` means always shown. Adding a product's screen is
// one entry here plus its page — no layout edits.
import { Products } from '@mocco/common/project';

import { Routes } from '@frontend/lib/routes';

import type { Product } from '@mocco/common/project';

export const WorkspaceSections = {
  overview: 'overview',
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
} as const;
export type ProjectSection = (typeof ProjectSections)[keyof typeof ProjectSections];

interface NavEntry<Key, Href> {
  key: Key;
  label: string;
  href: Href;
  /** The product that must be enabled for this section to show; null = always. */
  product: Product | null;
}

export const workspaceNav: readonly NavEntry<WorkspaceSection, (workspaceId: string) => string>[] = [
  { key: WorkspaceSections.overview, label: 'Overview', href: Routes.workspace, product: Products.governance },
  { key: WorkspaceSections.projects, label: 'Projects', href: Routes.workspaceProjects, product: null },
  { key: WorkspaceSections.members, label: 'Members', href: Routes.workspaceMembers, product: null },
  { key: WorkspaceSections.access, label: 'Access', href: Routes.workspaceAccess, product: Products.governance },
  { key: WorkspaceSections.notifications, label: 'Notifications', href: Routes.workspaceNotifications, product: null },
  { key: WorkspaceSections.audit, label: 'Audit', href: Routes.workspaceAudit, product: null },
  { key: WorkspaceSections.products, label: 'Products', href: Routes.workspaceProducts, product: null },
  { key: WorkspaceSections.settings, label: 'Settings', href: Routes.workspaceSettings, product: null },
];

export const projectNav: readonly NavEntry<ProjectSection, (workspaceId: string, projectId: string) => string>[] = [
  { key: ProjectSections.overview, label: 'Overview', href: Routes.project, product: null },
];

/** How each product is presented on the Products page. `available` = it has screens today. */
export const productCatalog: Readonly<Record<Product, { label: string; description: string; available: boolean }>> = {
  [Products.governance]: {
    label: 'Deploy governance',
    description: 'Gates, approvals and credential gating for your pipelines. Always on.',
    available: true,
  },
  [Products.ota]: {
    label: 'OTA and force update',
    description: 'Minimum and recommended app versions with gated changes, and gated publishing for your OTA tool.',
    available: true,
  },
  [Products.flags]: {
    label: 'Feature flags',
    description: 'Governed flag changes with OpenFeature SDKs.',
    available: false,
  },
  [Products.status]: {
    label: 'Status page',
    description: 'Uptime monitors, incidents and a public status page.',
    available: false,
  },
  [Products.reviews]: {
    label: 'App reviews',
    description: 'Store reviews analyzed and tied to releases.',
    available: false,
  },
  [Products.feedback]: {
    label: 'Feedback board',
    description: 'Public feedback, roadmap and changelog.',
    available: false,
  },
  [Products.messenger]: {
    label: 'Messenger',
    description: 'In-app customer chat for web and React Native.',
    available: false,
  },
  [Products.helpcenter]: {
    label: 'Help center',
    description: 'Product docs with automatic translation.',
    available: false,
  },
  [Products.forum]: { label: 'Forum', description: 'A community forum for your product.', available: false },
  [Products.links]: { label: 'Deep links', description: 'Smart links with deferred deep linking.', available: false },
  [Products.identity]: {
    label: 'End-user identity',
    description: 'Sign-in for your customers’ users.',
    available: false,
  },
};

/** Keep the entries whose product is enabled (or that need none). */
export function visibleEntries<Entry extends { product: Product | null }>(
  entries: readonly Entry[],
  enabled: readonly Product[],
): Entry[] {
  const on = new Set(enabled);
  return entries.filter(entry => entry.product === null || on.has(entry.product));
}
