/** The tenant scope every feedback query runs in: a project of a workspace. */
export interface FeedbackScope {
  workspaceId: string;
  projectId: string;
}
