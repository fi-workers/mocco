/** The tenant scope every status query runs in: a project of a workspace. */
export interface StatusScope {
  workspaceId: string;
  projectId: string;
}
