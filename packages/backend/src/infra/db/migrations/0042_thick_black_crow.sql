CREATE TABLE "mocco_help_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"short_id" text NOT NULL,
	"slug" text NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"draft_revision_id" uuid,
	"published_revision_id" uuid,
	"published_at" timestamp,
	"published_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_articles_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_help_articles_status_check" CHECK ("mocco_help_articles"."status" IN ('draft','published','archived'))
);
--> statement-breakpoint
CREATE TABLE "mocco_help_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_collections_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_help_redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"article_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_help_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text NOT NULL,
	"content_hash" text NOT NULL,
	"kind" text NOT NULL,
	"author_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_revisions_kind_check" CHECK ("mocco_help_revisions"."kind" IN ('source_edit','restore','import'))
);
--> statement-breakpoint
CREATE TABLE "mocco_help_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_sections_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_help_sites" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"source_locale" text NOT NULL,
	"locales" text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_help_articles" ADD CONSTRAINT "mocco_help_articles_published_by_user_id_mocco_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_articles" ADD CONSTRAINT "mocco_help_articles_section_fk" FOREIGN KEY ("section_id","workspace_id") REFERENCES "public"."mocco_help_sections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_collections" ADD CONSTRAINT "mocco_help_collections_site_fk" FOREIGN KEY ("project_id") REFERENCES "public"."mocco_help_sites"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_redirects" ADD CONSTRAINT "mocco_help_redirects_article_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."mocco_help_articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" ADD CONSTRAINT "mocco_help_revisions_author_user_id_mocco_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" ADD CONSTRAINT "mocco_help_revisions_article_fk" FOREIGN KEY ("article_id","workspace_id") REFERENCES "public"."mocco_help_articles"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_sections" ADD CONSTRAINT "mocco_help_sections_collection_fk" FOREIGN KEY ("collection_id","workspace_id") REFERENCES "public"."mocco_help_collections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_sites" ADD CONSTRAINT "mocco_help_sites_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_articles_project_short_uq" ON "mocco_help_articles" USING btree ("project_id","short_id");--> statement-breakpoint
CREATE INDEX "mocco_help_articles_section_position_idx" ON "mocco_help_articles" USING btree ("section_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_collections_project_slug_uq" ON "mocco_help_collections" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_redirects_project_path_uq" ON "mocco_help_redirects" USING btree ("project_id","from_path");--> statement-breakpoint
CREATE INDEX "mocco_help_revisions_article_locale_created_idx" ON "mocco_help_revisions" USING btree ("article_id","locale","created_at");--> statement-breakpoint
CREATE INDEX "mocco_help_sections_collection_position_idx" ON "mocco_help_sections" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_sites_slug_uq" ON "mocco_help_sites" USING btree ("slug");