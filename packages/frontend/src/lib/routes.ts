// Single source of truth for the app's page routes. Reference these instead of
// hardcoding path strings, so a route rename is one edit and typos are caught.
// (Static asset paths like /favicon.* are not app routes and live in _document.)
export const Routes = {
  home: '/',
  signIn: '/auth/sign-in',
  signUp: '/auth/sign-up',
  signOut: '/auth/sign-out',
  // Where the authorization server sends someone to approve an app (provider.ts CONSENT_PAGE).
  consent: '/auth/consent',
  workspaces: '/workspaces',
  /** A workspace's Deploys section (its repositories); GitHub setup returns here. */
  workspace: (id: string) => `/workspaces/${id}`,
  /** A workspace's Home: approvals waiting across products, recent activity, projects. */
  workspaceHome: (id: string) => `/workspaces/${id}/home`,
  workspaceMembers: (id: string) => `/workspaces/${id}/members`,
  workspaceAccess: (id: string) => `/workspaces/${id}/access`,
  workspaceAudit: (id: string) => `/workspaces/${id}/audit`,
  workspaceSettings: (id: string) => `/workspaces/${id}/settings`,
  workspaceNotifications: (id: string) => `/workspaces/${id}/notifications`,
  workspaceProjects: (id: string) => `/workspaces/${id}/projects`,
  workspaceProducts: (id: string) => `/workspaces/${id}/products`,
  /** A project's home: its apps and linked repos. Project-scoped products live below it. */
  project: (id: string, projectId: string) => `/workspaces/${id}/p/${projectId}`,
  /** A project's OTA screen (force update); `appId` selects the store app shown. */
  projectOta: (id: string, projectId: string, appId?: string) => {
    const path = `/workspaces/${id}/p/${projectId}/ota`;
    return appId === undefined ? path : `${path}?app=${encodeURIComponent(appId)}`;
  },
  /** Mocco-hosted OTA updates for the project's React Native app; `appId` selects the OTA app. */
  projectOtaHosting: (id: string, projectId: string, appId?: string) => {
    const path = `/workspaces/${id}/p/${projectId}/ota-hosting`;
    return appId === undefined ? path : `${path}?app=${encodeURIComponent(appId)}`;
  },
  /** One hosted OTA channel: its heads, waiting requests and history (`platform`, `range` are view state). */
  projectOtaChannel: (
    id: string,
    projectId: string,
    appId: string,
    channelId: string,
    view: { platform?: string; range?: string } = {},
  ) => {
    const query = new URLSearchParams({ app: appId });
    if (view.platform !== undefined) {
      query.set('platform', view.platform);
    }
    if (view.range !== undefined) {
      query.set('range', view.range);
    }
    return `/workspaces/${id}/p/${projectId}/ota-hosting/channels/${channelId}?${query.toString()}`;
  },
  /** One hosted OTA release: its updates, where it's served, adoption and approvals. */
  projectOtaRelease: (id: string, projectId: string, appId: string, releaseId: string) =>
    `/workspaces/${id}/p/${projectId}/ota-hosting/releases/${releaseId}?app=${encodeURIComponent(appId)}`,
  /** The project's feature flags; `environmentId` selects the environment whose history is shown. */
  projectFlags: (id: string, projectId: string, environmentId?: string) => {
    const path = `/workspaces/${id}/p/${projectId}/flags`;
    return environmentId === undefined ? path : `${path}?env=${encodeURIComponent(environmentId)}`;
  },
  /** One flag's targeting in an environment (`environmentId` selects it). */
  projectFlag: (id: string, projectId: string, flagKey: string, environmentId?: string) => {
    const path = `/workspaces/${id}/p/${projectId}/flags/${encodeURIComponent(flagKey)}`;
    return environmentId === undefined ? path : `${path}?env=${encodeURIComponent(environmentId)}`;
  },
  /** The project's messenger inbox (#95); `status=closed` lists the closed conversations. */
  projectInbox: (id: string, projectId: string, status?: 'open' | 'closed') =>
    `/workspaces/${id}/p/${projectId}/inbox${status === 'closed' ? '?status=closed' : ''}`,
  projectConversation: (id: string, projectId: string, conversationId: string) =>
    `/workspaces/${id}/p/${projectId}/inbox/${conversationId}`,
  /** The project's help center (#96): setup, then its collections, sections and articles. */
  projectHelp: (id: string, projectId: string) => `/workspaces/${id}/p/${projectId}/help`,
  projectHelpArticle: (id: string, projectId: string, articleId: string) =>
    `/workspaces/${id}/p/${projectId}/help/${articleId}`,
  /** The project's status pages (#148); `pageId` selects the page shown. */
  projectStatus: (id: string, projectId: string, pageId?: string) => {
    const path = `/workspaces/${id}/p/${projectId}/status`;
    return pageId === undefined ? path : `${path}?page=${encodeURIComponent(pageId)}`;
  },
  /** The project's API keys for the public /v1 API. */
  projectApiKeys: (id: string, projectId: string) => `/workspaces/${id}/p/${projectId}/api-keys`,
  /** The publishing tokens Mocco holds for the project's existing OTA tool. */
  projectOtaTokens: (id: string, projectId: string) => `/workspaces/${id}/p/${projectId}/ota-tokens`,
  workspaceCommit: (id: string, commitId: string) => `/workspaces/${id}/commits/${commitId}`,
  workspaceRun: (id: string, runId: string) => `/workspaces/${id}/runs/${runId}`,
  account: '/account',
  /** A customer guide page of a set, e.g. `guide('ota', 'force-update')` → `/docs/ota/force-update`. */
  guide: (set: string, page: string) => `/docs/${set}/${page}`,
  /** A notifications guide page, e.g. `notificationsGuide('sentry')` → `/docs/notifications/sentry`. */
  notificationsGuide: (page: string) => `/docs/notifications/${page}`,
  /** An OTA guide page, e.g. `otaGuide('gate-eas-update')` → `/docs/ota/gate-eas-update`. */
  otaGuide: (page: string) => `/docs/ota/${page}`,
  /** Starts the Discord bot install (a Hono route: full navigation, not a client push). */
  discordInstall: (workspaceId: string) => `/api/ext/discord/install?workspaceId=${encodeURIComponent(workspaceId)}`,
} as const;

// Only the static string routes — the dynamic builders (e.g. `workspace`) are
// called, not linked to directly.
export type Route = Extract<(typeof Routes)[keyof typeof Routes], string>;
