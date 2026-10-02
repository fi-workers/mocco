CREATE TABLE "mocco_help_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"state" text NOT NULL,
	"revision_id" uuid,
	"source_hash" text,
	"last_error" text,
	"reviewed_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_translations_state_check" CHECK ("mocco_help_translations"."state" IN ('pending','auto','reviewed','failed'))
);
--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" DROP CONSTRAINT "mocco_help_revisions_kind_check";--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD CONSTRAINT "mocco_help_translations_reviewed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD CONSTRAINT "mocco_help_translations_article_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."mocco_help_articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_translations_article_locale_uq" ON "mocco_help_translations" USING btree ("article_id","locale");--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" ADD CONSTRAINT "mocco_help_revisions_kind_check" CHECK ("mocco_help_revisions"."kind" IN ('source_edit','restore','import','machine','human_edit'));