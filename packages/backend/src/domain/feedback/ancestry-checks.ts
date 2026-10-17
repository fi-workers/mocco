// The ancestry questions of one release (#179), asked through the CommitAncestry port: each answer
// cached for the release, and a cap on the calls, so one release with many linked pull requests
// can't spend the installation's rate limit.
import type { CommitAncestry, TrackerRepoRef } from '@backend/domain/integration/ports';

/** The most ancestry questions one release asks GitHub; links past it wait for the next release. */
export const SHIP_ANCESTRY_CALL_CAP = 50;

/**
 * One release's questions: each answer cached by (ancestor, head), at most `cap` calls. `contains`
 * is undefined when it can't be told now (no GitHub App, the repo's installation unknown, the cap
 * reached, or GitHub failing), and the link waits for a later release.
 */
export class AncestryChecks {
  private readonly answers = new Map<string, boolean>();

  private calls = 0;

  constructor(
    private readonly ancestry: CommitAncestry | undefined,
    private readonly repo: TrackerRepoRef | undefined,
    private readonly cap: number = SHIP_ANCESTRY_CALL_CAP,
  ) {}

  /** How many questions went to the provider. */
  get callCount(): number {
    return this.calls;
  }

  async contains(ancestorSha: string, headSha: string): Promise<boolean | undefined> {
    if (ancestorSha === headSha) {
      return true;
    }
    const key = `${ancestorSha}...${headSha}`;
    const known = this.answers.get(key);
    if (known !== undefined) {
      return known;
    }
    if (this.ancestry === undefined || this.repo === undefined || this.calls >= this.cap) {
      return undefined;
    }
    this.calls += 1;
    try {
      const isContained = await this.ancestry.containsCommit(this.repo, ancestorSha, headSha);
      this.answers.set(key, isContained);
      return isContained;
    } catch (error) {
      console.error(
        `[feedback] asking whether ${headSha} contains ${ancestorSha} failed; trying again next release`,
        error,
      );
      return undefined;
    }
  }
}
