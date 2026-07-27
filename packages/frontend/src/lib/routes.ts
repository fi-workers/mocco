// Single source of truth for the app's page routes. Reference these instead of
// hardcoding path strings, so a route rename is one edit and typos are caught.
// (Static asset paths like /favicon.* are not app routes and live in _document.)
export const Routes = {
  home: '/',
  signIn: '/auth/sign-in',
  signUp: '/auth/sign-up',
  signOut: '/auth/sign-out',
  workspaces: '/workspaces',
  workspace: (id: string) => `/workspaces/${id}`,
  workspaceMembers: (id: string) => `/workspaces/${id}/members`,
  workspaceAccess: (id: string) => `/workspaces/${id}/access`,
  workspaceSettings: (id: string) => `/workspaces/${id}/settings`,
  workspaceCommit: (id: string, commitId: string) => `/workspaces/${id}/commits/${commitId}`,
  workspaceRun: (id: string, runId: string) => `/workspaces/${id}/runs/${runId}`,
  account: '/account',
} as const;

// Only the static string routes — the dynamic builders (e.g. `workspace`) are
// called, not linked to directly.
export type Route = Extract<(typeof Routes)[keyof typeof Routes], string>;
