import { z } from 'zod';

/**
 * Mocco's product lines (ADR 0013). The single source of truth: the DB check on
 * `mocco_workspace_products.product`, the enablement service, and product routers'
 * `productProcedure(...)` guards all reference this object — never a raw string.
 * `governance` (deploy governance) is implicitly enabled in every workspace.
 */
export const Products = {
  governance: 'governance',
  ota: 'ota',
  flags: 'flags',
  status: 'status',
  reviews: 'reviews',
  feedback: 'feedback',
  messenger: 'messenger',
  helpcenter: 'helpcenter',
  forum: 'forum',
  links: 'links',
  identity: 'identity',
} as const;
export type Product = (typeof Products)[keyof typeof Products];
export const productSchema = z.enum(Object.values(Products) as [Product, ...Product[]]);

/** A build target of a project. One project ships several apps (one per platform). */
export const AppPlatforms = {
  ios: 'ios',
  android: 'android',
  web: 'web',
  reactNative: 'react_native',
  server: 'server',
} as const;
export type AppPlatform = (typeof AppPlatforms)[keyof typeof AppPlatforms];
export const appPlatformSchema = z.enum(Object.values(AppPlatforms) as [AppPlatform, ...AppPlatform[]]);

/** How each platform is named to people: `iOS`, `React Native`. */
export const appPlatformLabels: Record<AppPlatform, string> = {
  [AppPlatforms.ios]: 'iOS',
  [AppPlatforms.android]: 'Android',
  [AppPlatforms.web]: 'Web',
  [AppPlatforms.reactNative]: 'React Native',
  [AppPlatforms.server]: 'Server',
};

/** A url-safe project handle: lowercase alphanumerics and inner hyphens, 1–40 chars.
 * Mirrors the DB CHECK on `mocco_projects.handle`. */
export const PROJECT_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A project: "a product the team ships", scoped to a workspace. Wire shape (tRPC `.output()`). */
export const projectSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  handle: z.string(),
  defaultLocale: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  archivedAt: z.date().nullable(),
});
export type ProjectDto = z.infer<typeof projectSchema>;

export const projectCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  handle: z.string().regex(PROJECT_HANDLE_PATTERN),
  defaultLocale: z.string().min(2).max(35).optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

/** An app of a project. Platform-specific identifiers are optional until a product needs them. */
export const projectAppSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  platform: appPlatformSchema,
  name: z.string(),
  bundleId: z.string().nullable(),
  storeAppId: z.string().nullable(),
  webOrigins: z.array(z.string()).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ProjectAppDto = z.infer<typeof projectAppSchema>;

/** The origin of a URL that is only a scheme and host (and port), else null. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    const isBare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '';
    return isBare ? url.origin : null;
  } catch {
    return null;
  }
}

/** A web origin: `https://host[:port]` (or `http://` for local development), no path. */
export const webOriginSchema = z
  .url({ protocol: /^https?$/u })
  .refine(value => originOf(value) !== null, {
    message: 'An origin is a scheme and host only, like https://app.acme.com',
  })
  .transform(value => originOf(value) ?? value);

/** The sites whose pages may use the project's publishable keys. */
export const webOriginsSchema = z.array(webOriginSchema).max(20);

export const projectAppCreateInputSchema = z.object({
  platform: appPlatformSchema,
  name: z.string().min(1).max(80),
  bundleId: z.string().min(1).max(255).optional(),
  storeAppId: z.string().min(1).max(255).optional(),
  webOrigins: webOriginsSchema.optional(),
});
export type ProjectAppCreateInput = z.infer<typeof projectAppCreateInputSchema>;

/** A repo linked to a project (a repo may belong to several projects, e.g. a monorepo). */
export const projectRepoSchema = z.object({
  projectId: z.uuid(),
  repoId: z.uuid(),
  createdAt: z.date(),
});
export type ProjectRepoDto = z.infer<typeof projectRepoSchema>;
