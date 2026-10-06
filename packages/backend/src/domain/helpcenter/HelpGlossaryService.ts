// A help center's glossary (#214): terms kept as written in every language (product names,
// UI labels) and terms translated one fixed way per language. The translation pipeline
// follows it (translate/glossary.ts). Every change recomputes the site's glossary hash,
// is audited, and, when the hash moved, hands over to `onChanged`, which queues the
// re-translation of only the segments that contain a changed term.
import { AuditActions } from '@mocco/common/audit';
import { GlossaryLimits, glossaryTermInputSchema } from '@mocco/common/help';

import {
  HelpGlossaryFullError,
  HelpGlossaryTermExistsError,
  HelpGlossaryTermNotFoundError,
} from '@backend/domain/helpcenter/errors';
import { HelpGlossaryTermRepo } from '@backend/domain/helpcenter/repos/glossary-term.repo';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { siteGlossaryHash } from '@backend/domain/helpcenter/translate/glossary';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { HelpGlossaryTermRow } from '@backend/domain/helpcenter/repos/glossary-term.repo';
import type { Db } from '@backend/infra/db/types';
import type { GlossaryTermInput } from '@mocco/common/help';

export interface HelpGlossaryDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  sites: Pick<HelpSiteService, 'require'>;
  /** Runs after a change that moved the glossary hash (queues the re-translation). */
  onChanged?: (workspaceId: string, projectId: string, glossaryHash: string) => Promise<void>;
}

const toDto = (row: HelpGlossaryTermRow) => ({
  id: row.id,
  term: row.term,
  rule: row.rule,
  translations: row.translations,
  note: row.note,
  updatedAt: row.updatedAt,
});

/** A term's values as stored, from the parsed input. */
const valuesOf = (input: GlossaryTermInput) => {
  const parsed = glossaryTermInputSchema.parse(input);
  return { term: parsed.term, rule: parsed.rule, translations: parsed.translations, note: parsed.note };
};

/** Whether two terms say the same thing (an import of an unchanged term changes nothing). */
const isSame = (row: HelpGlossaryTermRow, values: ReturnType<typeof valuesOf>) =>
  row.note === values.note && siteGlossaryHash([row]) === siteGlossaryHash([values]);

/** Map the term's unique index to the domain error; rethrow anything else. */
async function termChecked<T>(term: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof UniqueConstraintError && error.constraint === 'mocco_help_glossary_terms_term_uq') {
      throw new HelpGlossaryTermExistsError(term, { cause: error });
    }
    throw error;
  }
}

export class HelpGlossaryService {
  constructor(private readonly deps: HelpGlossaryDeps) {}

  /** Recompute and store the site's glossary hash, audit the change, and hand over when the hash moved. */
  private async changed(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    terms: { added?: string[]; changed?: string[]; removed?: string[] },
  ): Promise<void> {
    const before = await this.deps.sites.require(workspaceId, projectId);
    const rows = await new HelpGlossaryTermRepo(this.deps.db).list(workspaceId, projectId);
    const glossaryHash = siteGlossaryHash(rows);
    if (glossaryHash !== before.glossaryHash) {
      await new HelpSiteRepo(this.deps.db).update(workspaceId, projectId, { glossaryHash });
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpGlossaryChanged,
      subjectType: 'project',
      subjectId: projectId,
      payload: { ...terms, glossaryHash },
    });
    if (glossaryHash !== before.glossaryHash) {
      await this.deps.onChanged?.(workspaceId, projectId, glossaryHash);
    }
  }

  /** The site's terms, alphabetically, and the glossary hash translations compare against. */
  async list(workspaceId: string, projectId: string) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const terms = await new HelpGlossaryTermRepo(this.deps.db).list(workspaceId, projectId);
    return { glossaryHash: site.glossaryHash, terms: terms.map(row => toDto(row)) };
  }

  async addTerm(workspaceId: string, projectId: string, actorUserId: string, input: GlossaryTermInput) {
    await this.deps.sites.require(workspaceId, projectId);
    const values = valuesOf(input);
    const repo = new HelpGlossaryTermRepo(this.deps.db);
    const terms = await repo.list(workspaceId, projectId);
    if (terms.length >= GlossaryLimits.termsMax) {
      throw new HelpGlossaryFullError(GlossaryLimits.termsMax);
    }
    const row = await termChecked(values.term, async () => await repo.insert({ workspaceId, projectId, ...values }));
    await this.changed(workspaceId, projectId, actorUserId, { added: [row.term] });
    return toDto(row);
  }

  async updateTerm(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    termId: string,
    input: GlossaryTermInput,
  ) {
    await this.deps.sites.require(workspaceId, projectId);
    const values = valuesOf(input);
    const row = await termChecked(
      values.term,
      async () => await new HelpGlossaryTermRepo(this.deps.db).update(workspaceId, projectId, termId, values),
    );
    if (row === undefined) {
      throw new HelpGlossaryTermNotFoundError(termId);
    }
    await this.changed(workspaceId, projectId, actorUserId, { changed: [row.term] });
    return toDto(row);
  }

  async removeTerm(workspaceId: string, projectId: string, actorUserId: string, termId: string): Promise<void> {
    await this.deps.sites.require(workspaceId, projectId);
    const repo = new HelpGlossaryTermRepo(this.deps.db);
    const row = await repo.find(workspaceId, projectId, termId);
    if (row === undefined || !(await repo.delete(workspaceId, projectId, termId))) {
      throw new HelpGlossaryTermNotFoundError(termId);
    }
    await this.changed(workspaceId, projectId, actorUserId, { removed: [row.term] });
  }

  /**
   * Add or update many terms at once (a CSV import): a term the glossary has, in any case,
   * is updated, any other added; terms not in the import stay. One audit entry and one
   * re-translation for the whole import.
   */
  async importTerms(workspaceId: string, projectId: string, actorUserId: string, inputs: readonly GlossaryTermInput[]) {
    await this.deps.sites.require(workspaceId, projectId);
    const parsed = inputs.map(input => valuesOf(input));
    const result = await this.deps.db.transaction(async tx => {
      const repo = new HelpGlossaryTermRepo(tx);
      const rows = await repo.list(workspaceId, projectId);
      const existing = new Map(rows.map(row => [row.term.toLowerCase(), row]));
      const added: string[] = [];
      const changed: string[] = [];
      // The last row for a term wins, as a spreadsheet's later line would.
      const byTerm = new Map(parsed.map(values => [values.term.toLowerCase(), values]));
      const fresh = new Set(parsed.map(values => values.term.toLowerCase()).filter(key => !existing.has(key)));
      if (existing.size + fresh.size > GlossaryLimits.termsMax) {
        throw new HelpGlossaryFullError(GlossaryLimits.termsMax);
      }
      // eslint-disable-next-line no-restricted-syntax -- writes in order inside one transaction
      for (const [key, values] of byTerm) {
        const row = existing.get(key);
        if (row === undefined) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, one connection: the writes go in order
          await repo.insert({ workspaceId, projectId, ...values });
          added.push(values.term);
        } else if (!isSame(row, values)) {
          // eslint-disable-next-line no-await-in-loop -- one transaction, one connection: the writes go in order
          await repo.update(workspaceId, projectId, row.id, values);
          changed.push(values.term);
        }
      }
      return { added, changed, unchanged: byTerm.size - added.length - changed.length };
    });
    if (result.added.length > 0 || result.changed.length > 0) {
      await this.changed(workspaceId, projectId, actorUserId, { added: result.added, changed: result.changed });
    }
    return { added: result.added.length, changed: result.changed.length, unchanged: result.unchanged };
  }
}
