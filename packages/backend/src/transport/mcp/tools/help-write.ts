// The help center's changing tools (#480): accept a machine draft as the reviewed translation,
// ask the machine to translate a language again, and add, change or remove a glossary term.
//
// Thin adapters (ADR 0025) over `HelpTranslationService` (`acceptProposal`, `retranslate`) and
// `HelpGlossaryService` (`addTerm`, `updateTerm`, `removeTerm`), the services the console's
// `help` router calls for the same changes; each tool calls one of them, after `ProjectScope`
// has checked the caller's workspace, project and `Products.helpcenter`, and acts as the caller.
//
// They have the locks of every changing tool (`openDecision`, `confirmThenApply`): `help:write`,
// the workspace's opt-in, and a confirmation naming exactly what would change. Each confirmation
// is bound to the state it was asked about, so an answer given after that state moved is refused
// as a different change: an accept to the draft and the published source revision, a
// retranslate to the language's state and its current text, a glossary change to the term's
// value. Replacing a reviewed language passes the console's explicit `confirm` only when the
// state the person confirmed was reviewed; if it became reviewed since, the service refuses.
import { isDeepStrictEqual } from 'node:util';

import { GlossaryRules, glossaryTermInputSchema, helpLocaleSchema, TranslationStates } from '@mocco/common/help';
import { McpScopes } from '@mocco/common/mcp';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { confirmThenApply, openDecision, refused, requireScope } from '@backend/transport/mcp/tools/deciding';
import { asJson, workspaceArg } from '@backend/transport/mcp/tools/runs';

import type { HelpGlossaryService } from '@backend/domain/helpcenter/HelpGlossaryService';
import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import type { ProjectInScope, ProjectScope } from '@backend/domain/mcp/ProjectScope';
import type { DecidingToolDeps, DecisionWords } from '@backend/transport/mcp/tools/deciding';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

export interface HelpWriteToolDeps extends DecidingToolDeps {
  /** One language's review (what a change is bound to), and the console's two translation changes. */
  helpTranslations: Pick<HelpTranslationService, 'reviewByShortId' | 'acceptProposal' | 'retranslate'>;
  /** The glossary as it is now, and the console's term changes. */
  helpGlossary: Pick<HelpGlossaryService, 'list' | 'addTerm' | 'updateTerm' | 'removeTerm'>;
  projects: Pick<ProjectScope, 'resolve'>;
}

export const HELP_ACCEPT_TOOL = 'mocco_help_translation_accept';
export const HELP_RETRANSLATE_TOOL = 'mocco_help_translation_retranslate';
export const HELP_GLOSSARY_SET_TOOL = 'mocco_help_glossary_set';

/** How much of a draft the confirmation shows. */
const EXCERPT_CHARS = 600;

const projectArg = z
  .uuid()
  .optional()
  .describe('The project the help center belongs to. Omit it when the workspace has exactly one.');

const articleArg = z
  .string()
  .regex(/^[a-z0-9]{6}(?:-[a-z0-9-]{0,80})?$/u)
  .describe(
    'The article id (6 characters), or the `{id}-{slug}` from its path, as `mocco_help_translations_list` returns it.',
  );

const localeArg = helpLocaleSchema.describe(
  'The language of the translation (`ko`, `ja`, …): one the help center offers.',
);

const acceptInput = z.object({
  articleId: articleArg,
  locale: localeArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const retranslateInput = z.object({
  articleId: articleArg,
  locale: localeArg,
  workspaceId: workspaceArg,
  projectId: projectArg,
});

const glossarySetInput = z.object({
  term: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'The term, as it is written in the source language. A term the glossary has (in any case) is changed or removed; any other is added.',
    ),
  rule: z
    .enum([GlossaryRules.keep, GlossaryRules.fixed])
    .optional()
    .describe(
      '`keep`: kept as written in every language (a product name, a UI label). `fixed`: translated one fixed way per language, given in `translations`. Needed unless `remove`.',
    ),
  translations: z
    .partialRecord(helpLocaleSchema, z.string())
    .optional()
    .describe(
      'For `fixed`: the term in each language that has a fixed translation (`{ "de": "Steuerelement" }`). Replaces them all.',
    ),
  note: z.string().max(500).optional().describe('A note for the team. Omit it to keep the note the term has.'),
  remove: z.boolean().default(false).describe('Remove the term from the glossary instead.'),
  workspaceId: workspaceArg,
  projectId: projectArg,
});

export type AcceptTranslationArgs = z.infer<typeof acceptInput>;
export type RetranslateArgs = z.infer<typeof retranslateInput>;
export type GlossarySetArgs = z.infer<typeof glossarySetInput>;

/** Domain refusals the model reads and can act on; anything else is a fault. */
function helpRefusal(error: unknown): CallToolResult {
  if (
    error instanceof NotFoundError ||
    error instanceof BadRequestError ||
    error instanceof ForbiddenError ||
    error instanceof ConflictError
  ) {
    return refused(error.message);
  }
  throw error;
}

const resolveHelpProject = async (deps: HelpWriteToolDeps, userId: string, asked: Partial<ProjectInScope>) =>
  await deps.projects.resolve(userId, asked, Products.helpcenter);

/** One language of an article as review reads it now, by the id agents know it by. */
async function reviewOf(deps: HelpWriteToolDeps, scope: ProjectInScope, args: { articleId: string; locale: string }) {
  const [shortId = args.articleId] = args.articleId.split('-');
  return await deps.helpTranslations.reviewByShortId(scope.workspaceId, scope.projectId, shortId, args.locale);
}

// eslint-disable-next-line sonarjs/null-dereference -- a string parameter, never null
const excerpt = (text: string) => (text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text);

/** One permission for every help center change, worded as the consent screen words it. */
const writeScope = () => ({
  name: McpScopes.helpWrite,
  allows: 'review your help center translations and change its glossary',
});

const acceptWords: DecisionWords = {
  verb: 'accept help center translations',
  doing: 'Accepting a machine draft',
  scope: writeScope(),
  instead: "accept it from the language's review in the Mocco console",
};
const retranslateWords: DecisionWords = {
  verb: 'translate help articles again',
  doing: 'Translating a help article again',
  scope: writeScope(),
  instead: 'translate it again from the translations page in the Mocco console',
};
const glossaryWords: DecisionWords = {
  verb: 'change the help center glossary',
  doing: 'Changing the glossary',
  scope: writeScope(),
  instead: 'change it from the glossary page in the Mocco console',
};

/** Make the machine draft beside a stale reviewed translation the reviewed text, once the caller confirms it. */
export async function acceptTranslation(
  deps: HelpWriteToolDeps,
  args: AcceptTranslationArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, acceptWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveHelpProject(deps, userId, { workspaceId, projectId: args.projectId });
    const review = await reviewOf(deps, scope, args);
    const { proposal } = review;
    if (proposal === null || review.sourceRevisionId === null) {
      return refused(
        `No machine draft waits in ${args.locale} for article ${review.article.shortId} and its current source. Read it again with mocco_help_translation_get.`,
      );
    }
    // Bound to this draft and the source it was made from: a newer draft or a new publish asks again.
    const change = {
      tool: HELP_ACCEPT_TOOL,
      ...scope,
      articleId: review.article.id,
      locale: args.locale,
      proposalRevisionId: proposal.revisionId,
      sourceRevisionId: review.sourceRevisionId,
    };
    const replaces =
      review.reviewedBy === null
        ? 'It replaces the current text.'
        : `It replaces the text ${review.reviewedBy} reviewed; that text stays in the history.`;
    const question = [
      `Accept the machine draft of article ${review.article.shortId} in ${args.locale} as the reviewed translation, as you?`,
      replaces,
      '',
      proposal.title,
      '',
      excerpt(proposal.body),
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: 'Accept this draft',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const accepted = await deps.helpTranslations.acceptProposal(scope.workspaceId, scope.projectId, userId, {
          articleId: review.article.id,
          locale: args.locale,
          proposalRevisionId: proposal.revisionId,
        });
        return asJson({
          accepted: true,
          id: review.article.shortId,
          locale: accepted.locale,
          state: accepted.state,
          reviewedBy: accepted.reviewedBy,
          reviewedAt: accepted.reviewedAt,
        });
      },
    });
  } catch (error) {
    return helpRefusal(error);
  }
}

/** States in which a language is on its way to a new text already. */
const isUnderway = (state: string | null) =>
  state === TranslationStates.pending || state === TranslationStates.translating;

/** Ask the machine again for one language, once the caller confirms it, replacing a reviewed text only then. */
export async function retranslateLanguage(
  deps: HelpWriteToolDeps,
  args: RetranslateArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, retranslateWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveHelpProject(deps, userId, { workspaceId, projectId: args.projectId });
    const review = await reviewOf(deps, scope, args);
    if (!review.isAvailable) {
      return refused('Machine translation is not set up on this server, so nothing can be translated again.');
    }
    if (review.sourceRevisionId === null) {
      return refused(`Article ${review.article.shortId} is not published, so there is no source to translate.`);
    }
    if (isUnderway(review.state)) {
      return asJson({
        changed: false,
        id: review.article.shortId,
        locale: args.locale,
        state: review.state,
        reason: 'It is being translated already.',
      });
    }
    const isReviewed = review.state === TranslationStates.reviewed;
    // Bound to the language as it is now: its state and its text. If someone reviews or edits
    // it before the answer, the person is asked again, about that text.
    const change = {
      tool: HELP_RETRANSLATE_TOOL,
      ...scope,
      articleId: review.article.id,
      locale: args.locale,
      state: review.state,
      textRevisionId: review.textRevisionId,
      sourceRevisionId: review.sourceRevisionId,
    };
    const reviewer = review.reviewedBy === null ? 'a person' : review.reviewedBy;
    const question = isReviewed
      ? [
          `Replace the reviewed ${args.locale} translation of article ${review.article.shortId} with a new machine translation, as you?`,
          `It was reviewed by ${reviewer}. The site shows the machine's text once it is done; the reviewed text stays in the history.`,
        ].join('\n')
      : [
          `Translate article ${review.article.shortId} into ${args.locale} again by machine, as you?`,
          'It is translated from the published source, without reusing earlier translations.',
        ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: isReviewed ? 'Replace the reviewed translation' : 'Translate again',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        // The console's explicit confirm, given only for the reviewed state the person confirmed:
        // a language reviewed since is refused by the service, not overwritten.
        await deps.helpTranslations.retranslate(scope.workspaceId, scope.projectId, userId, {
          articleId: review.article.id,
          locale: args.locale,
          confirm: isReviewed,
        });
        return asJson({
          queued: true,
          id: review.article.shortId,
          locale: args.locale,
          replacesReviewed: isReviewed,
        });
      },
    });
  } catch (error) {
    return helpRefusal(error);
  }
}

type GlossaryTerm = Awaited<ReturnType<HelpWriteToolDeps['helpGlossary']['list']>>['terms'][number];

/** A term's value in the confirmation's words. */
const describeTerm = (term: { term: string; rule: string; translations: Partial<Record<string, string>> }) => {
  if (term.rule === GlossaryRules.keep) {
    return `"${term.term}", kept as written in every language`;
  }
  const fixed = Object.entries(term.translations)
    .map(([locale, text]) => `${locale}: ${text ?? ''}`)
    .join(', ');
  return `"${term.term}", translated as ${fixed}`;
};

/** What a term is, as a confirmation is bound to it. */
const valueOf = (term: GlossaryTerm) => ({
  id: term.id,
  term: term.term,
  rule: term.rule,
  translations: term.translations,
  note: term.note,
});

/** Add, change or remove a glossary term, once the caller confirms the change from its value now. */
export async function setGlossaryTerm(
  deps: HelpWriteToolDeps,
  args: GlossarySetArgs,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const opened = await openDecision(deps, ctx, args.workspaceId, glossaryWords);
    if ('content' in opened) {
      return opened;
    }
    const { userId, workspaceId, confirmations } = opened;
    const scope = await resolveHelpProject(deps, userId, { workspaceId, projectId: args.projectId });
    const { terms } = await deps.helpGlossary.list(scope.workspaceId, scope.projectId);
    const key = args.term.toLowerCase();
    const existing = terms.find(each => each.term.toLowerCase() === key);
    const unchanged = (reason: string) => asJson({ changed: false, term: args.term, reason });

    if (args.remove) {
      if (existing === undefined) {
        return unchanged('The glossary does not have it.');
      }
      const change = { tool: HELP_GLOSSARY_SET_TOOL, ...scope, before: valueOf(existing), after: null };
      const question = [
        `Remove "${existing.term}" from the help center glossary, as you?`,
        `Now: ${describeTerm(existing)}`,
        'Translations stop following it; the segments that contain it are translated again in each language it applied to.',
      ].join('\n');
      return await confirmThenApply(ctx, confirmations, change, {
        label: 'Remove this term',
        ask: async () => await Promise.resolve(question),
        apply: async () => {
          await deps.helpGlossary.removeTerm(scope.workspaceId, scope.projectId, userId, existing.id);
          return asJson({ changed: true, removed: true, term: existing.term });
        },
      });
    }

    if (args.rule === undefined) {
      return refused('Say how the term is translated: `rule` is `keep` or `fixed` (or pass `remove`).');
    }
    const parsed = glossaryTermInputSchema.safeParse({
      term: args.term,
      rule: args.rule,
      translations: args.translations ?? {},
      note: args.note ?? existing?.note ?? '',
    });
    if (!parsed.success) {
      return refused(parsed.error.issues.map(issue => issue.message).join('; '));
    }
    const after = parsed.data;
    if (existing !== undefined && isDeepStrictEqual(valueOf(existing), { id: existing.id, ...after })) {
      return unchanged('The glossary has it like this already.');
    }
    // Bound to the term as it is now (or to its absence): a change made since asks again.
    const change = {
      tool: HELP_GLOSSARY_SET_TOOL,
      ...scope,
      before: existing === undefined ? null : valueOf(existing),
      after,
    };
    const question = [
      ...(existing === undefined
        ? [`Add "${after.term}" to the help center glossary, as you?`, `As: ${describeTerm(after)}`]
        : [
            `Change "${existing.term}" in the help center glossary, as you?`,
            `Now: ${describeTerm(existing)}`,
            `After: ${describeTerm(after)}`,
          ]),
      ...(after.note === '' ? [] : [`Note: ${after.note}`]),
      'Every translation follows the glossary: the segments that contain the term are translated again; a reviewed language gets a draft beside its text instead.',
    ].join('\n');
    return await confirmThenApply(ctx, confirmations, change, {
      label: existing === undefined ? 'Add this term' : 'Change this term',
      ask: async () => await Promise.resolve(question),
      apply: async () => {
        const saved =
          existing === undefined
            ? await deps.helpGlossary.addTerm(scope.workspaceId, scope.projectId, userId, after)
            : await deps.helpGlossary.updateTerm(scope.workspaceId, scope.projectId, userId, existing.id, after);
        return asJson({
          changed: true,
          ...(existing === undefined ? { added: true } : { updated: true }),
          id: saved.id,
          term: saved.term,
          rule: saved.rule,
          translations: saved.translations,
          note: saved.note,
        });
      },
    });
  } catch (error) {
    return helpRefusal(error);
  }
}

const challenge = (doing: string) =>
  requireScope(McpScopes.helpWrite, `${doing} needs your permission for this app to change your help center`);
const changing = { readOnlyHint: false, openWorldHint: false } as const;

export function registerHelpWriteTools(server: McpServer, deps: HelpWriteToolDeps): void {
  server.registerTool(
    HELP_ACCEPT_TOOL,
    {
      title: 'Accept a machine draft of a help translation',
      description:
        "Make the machine draft that waits beside a stale reviewed translation (`hasProposal` in mocco_help_translation_get) the language's reviewed text, as the signed-in person. Tied to that draft and the article's published source: a newer draft or a new publish asks again. The person confirms first, and it only works where the workspace allows agents to make changes.",
      inputSchema: acceptInput,
      annotations: { ...changing, destructiveHint: false, idempotentHint: true },
      scopeChallenge: challenge('Accepting a draft'),
    },
    async (args, ctx) => await acceptTranslation(deps, args, ctx),
  );

  server.registerTool(
    HELP_RETRANSLATE_TOOL,
    {
      title: 'Translate a help article again',
      description:
        'Ask the machine to translate one language of a published help article again, from the source and without reusing earlier translations, as the signed-in person. A language a person reviewed is replaced only when the person confirms exactly that (its text stays in the history). The person confirms first, and it only works where the workspace allows agents to make changes. The translation runs in the background; read it with mocco_help_translation_get.',
      inputSchema: retranslateInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: false },
      scopeChallenge: challenge('Translating again'),
    },
    async (args, ctx) => await retranslateLanguage(deps, args, ctx),
  );

  server.registerTool(
    HELP_GLOSSARY_SET_TOOL,
    {
      title: 'Add, change or remove a glossary term',
      description:
        'Set a term in the help center glossary every translation follows, as the signed-in person: add it, change how it is translated (`keep` as written, or `fixed` with one translation per language), or `remove` it. Translations then redo the segments that contain it. Tied to the term as it is now: a change made since asks again. The person confirms first, and it only works where the workspace allows agents to make changes.',
      inputSchema: glossarySetInput,
      annotations: { ...changing, destructiveHint: true, idempotentHint: true },
      scopeChallenge: challenge('Changing the glossary'),
    },
    async (args, ctx) => await setGlossaryTerm(deps, args, ctx),
  );
}
