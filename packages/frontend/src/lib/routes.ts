// Single source of truth for the app's page routes. Reference these instead of
// hardcoding path strings, so a route rename is one edit and typos are caught.
// (Static asset paths like /favicon.* are not app routes and live in _document.)
export const Routes = {
  home: '/',
  signIn: '/auth/sign-in',
  signUp: '/auth/sign-up',
  signOut: '/auth/sign-out',
  workspaces: '/workspaces',
  account: '/account',
  pipelinePreview: '/pipelines/new',
} as const;

export type Route = (typeof Routes)[keyof typeof Routes];
