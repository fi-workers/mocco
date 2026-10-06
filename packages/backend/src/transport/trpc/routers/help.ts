// Help center router (#96): the project's help site, its tree, and writing and
// publishing articles. Every procedure requires the help center product to be enabled
// and the project to belong to the workspace (`productProcedure`).
import {
  articleCreateInputSchema,
  collectionInputSchema,
  draftInputSchema,
  GlossaryLimits,
  glossaryTermInputSchema,
  helpImageInputSchema,
  helpSiteInputSchema,
  helpLocaleSchema,
  sectionInputSchema,
  translationGridInputSchema,
  translationInputSchema,
} from '@mocco/common/help';
import { importBundleSchema } from '@mocco/common/help-import';
import { helpfulnessSchema } from '@mocco/common/help-v1';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const articleInput = projectInput.extend({ articleId: z.uuid() });
const helpProcedure = productProcedure(Products.helpcenter);

export const helpRouter = router({
  /** The site, or null while the project has no help center. */
  site: helpProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    site: (await ctx.helpSites.get(input.workspaceId, input.projectId)) ?? null,
  })),

  enable: helpProcedure
    .input(projectInput.and(helpSiteInputSchema))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpSites.enable(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  updateSite: helpProcedure
    .input(projectInput.and(helpSiteInputSchema))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpSites.update(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  setAiTraining: helpProcedure
    .input(projectInput.extend({ allowAiTraining: z.boolean() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpSites.setAiTraining(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.allowAiTraining,
        ),
    ),

  /** "Was this helpful?" over the last 30 days, with the newest comments. */
  helpfulness: helpProcedure
    .input(articleInput)
    .output(helpfulnessSchema)
    .query(
      async ({ ctx, input }) => await ctx.helpFeedback.helpfulness(input.workspaceId, input.projectId, input.articleId),
    ),

  tree: helpProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    collections: await ctx.helpAuthoring.tree(input.workspaceId, input.projectId),
  })),

  createCollection: helpProcedure
    .input(projectInput.extend(collectionInputSchema.shape))
    .mutation(
      async ({ ctx, input }) => await ctx.helpAuthoring.createCollection(input.workspaceId, input.projectId, input),
    ),

  deleteCollection: helpProcedure
    .input(projectInput.extend({ collectionId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.helpAuthoring.deleteCollection(input.workspaceId, input.projectId, input.collectionId);
      return { ok: true } as const;
    }),

  createSection: helpProcedure
    .input(projectInput.extend(sectionInputSchema.shape))
    .mutation(
      async ({ ctx, input }) => await ctx.helpAuthoring.createSection(input.workspaceId, input.projectId, input),
    ),

  deleteSection: helpProcedure.input(projectInput.extend({ sectionId: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.helpAuthoring.deleteSection(input.workspaceId, input.projectId, input.sectionId);
    return { ok: true } as const;
  }),

  createArticle: helpProcedure
    .input(projectInput.extend(articleCreateInputSchema.shape))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpAuthoring.createArticle(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  article: helpProcedure
    .input(articleInput)
    .query(
      async ({ ctx, input }) => await ctx.helpAuthoring.article(input.workspaceId, input.projectId, input.articleId),
    ),

  saveDraft: helpProcedure
    .input(projectInput.extend(draftInputSchema.shape))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpAuthoring.saveDraft(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  publish: helpProcedure
    .input(articleInput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpAuthoring.publish(input.workspaceId, input.projectId, ctx.session.user.id, input.articleId),
    ),

  unpublish: helpProcedure
    .input(articleInput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpAuthoring.unpublish(input.workspaceId, input.projectId, ctx.session.user.id, input.articleId),
    ),

  deleteArticle: helpProcedure.input(articleInput).mutation(async ({ ctx, input }) => {
    await ctx.helpAuthoring.deleteArticle(input.workspaceId, input.projectId, ctx.session.user.id, input.articleId);
    return { ok: true } as const;
  }),

  history: helpProcedure.input(articleInput).query(async ({ ctx, input }) => ({
    revisions: await ctx.helpAuthoring.history(input.workspaceId, input.projectId, input.articleId),
  })),

  restore: helpProcedure
    .input(articleInput.extend({ revisionId: z.uuid() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpAuthoring.restore(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.articleId,
          input.revisionId,
        ),
    ),

  /** Reserve a public upload for an article image; PUT it, then `completeImage`. */
  createImageUpload: helpProcedure
    .input(projectInput.extend(helpImageInputSchema.shape))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpImages.createImageUpload(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** The uploaded image's public URL, once storage verified it. */
  completeImage: helpProcedure
    .input(projectInput.extend({ objectId: z.uuid() }))
    .mutation(
      async ({ ctx, input }) => await ctx.helpImages.completeImage(input.workspaceId, input.projectId, input.objectId),
    ),

  /** Import articles (from Mintlify, converted in the console); importing again updates them. */
  importBundle: helpProcedure.input(projectInput.extend({ bundle: importBundleSchema, publish: z.boolean() })).mutation(
    async ({ ctx, input }) =>
      await ctx.helpImport.importBundle(input.workspaceId, input.projectId, ctx.session.user.id, input.bundle, {
        publish: input.publish,
      }),
  ),

  /** Every offered language of an article: state, staleness and text. */
  translations: helpProcedure
    .input(articleInput)
    .query(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.translations(input.workspaceId, input.projectId, input.articleId),
    ),

  /** A person's translation, kept as reviewed (the machine never overwrites it). */
  saveTranslation: helpProcedure
    .input(projectInput.extend(translationInputSchema.shape))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.saveTranslation(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** The translations dashboard: per-language counts and the published articles × languages, filtered and paged. */
  translationGrid: helpProcedure
    .input(projectInput.extend(translationGridInputSchema.shape))
    .query(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...grid } = input;
      return await ctx.helpTranslations.grid(workspaceId, projectId, grid);
    }),

  /** One language for review: source beside text, reviewer, machine draft and the source's segment diff. */
  translationReview: helpProcedure
    .input(articleInput.extend({ locale: helpLocaleSchema }))
    .query(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.review(input.workspaceId, input.projectId, input.articleId, input.locale),
    ),

  /** Make the machine draft beside a stale reviewed translation the reviewed text. */
  acceptProposal: helpProcedure
    .input(articleInput.extend({ locale: helpLocaleSchema, proposalRevisionId: z.uuid() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.acceptProposal(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** Ask the machine again for one language; replacing a reviewed translation needs `confirm`. */
  retranslate: helpProcedure
    .input(articleInput.extend({ locale: helpLocaleSchema, confirm: z.boolean().optional() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.retranslate(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** The glossary: terms kept as written, and terms with a fixed translation per language. */
  glossary: helpProcedure
    .input(projectInput)
    .query(async ({ ctx, input }) => await ctx.helpGlossary.list(input.workspaceId, input.projectId)),

  addGlossaryTerm: helpProcedure
    .input(projectInput.extend({ term: glossaryTermInputSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpGlossary.addTerm(input.workspaceId, input.projectId, ctx.session.user.id, input.term),
    ),

  updateGlossaryTerm: helpProcedure
    .input(projectInput.extend({ termId: z.uuid(), term: glossaryTermInputSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpGlossary.updateTerm(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.termId,
          input.term,
        ),
    ),

  removeGlossaryTerm: helpProcedure
    .input(projectInput.extend({ termId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.helpGlossary.removeTerm(input.workspaceId, input.projectId, ctx.session.user.id, input.termId);
      return { ok: true } as const;
    }),

  /** Add or update many terms (a CSV import, parsed in the console); terms left out stay. */
  importGlossary: helpProcedure
    .input(projectInput.extend({ terms: z.array(glossaryTermInputSchema).min(1).max(GlossaryLimits.termsMax) }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpGlossary.importTerms(input.workspaceId, input.projectId, ctx.session.user.id, input.terms),
    ),
});
