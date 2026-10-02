// Help center router (#96): the project's help site, its tree, and writing and
// publishing articles. Every procedure requires the help center product to be enabled
// and the project to belong to the workspace (`productProcedure`).
import {
  articleCreateInputSchema,
  collectionInputSchema,
  draftInputSchema,
  helpImageInputSchema,
  helpSiteInputSchema,
  helpLocaleSchema,
  sectionInputSchema,
  translationInputSchema,
} from '@mocco/common/help';
import { importBundleSchema } from '@mocco/common/help-import';
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
        await ctx.helpImport.createImageUpload(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** The uploaded image's public URL, once storage verified it. */
  completeImage: helpProcedure
    .input(projectInput.extend({ objectId: z.uuid() }))
    .mutation(
      async ({ ctx, input }) => await ctx.helpImport.completeImage(input.workspaceId, input.projectId, input.objectId),
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

  /** Ask the machine again for one language (replacing a reviewed translation too). */
  retranslate: helpProcedure
    .input(articleInput.extend({ locale: helpLocaleSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.helpTranslations.retranslate(input.workspaceId, input.projectId, input.articleId, input.locale),
    ),
});
