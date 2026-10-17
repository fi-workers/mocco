CREATE TABLE "mocco_changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp,
	"published_at" timestamp,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_changelog_entries_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_changelog_entries_slug_check" CHECK ("mocco_changelog_entries"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
	CONSTRAINT "mocco_changelog_entries_state_check" CHECK ("mocco_changelog_entries"."state" IN ('draft','scheduled','published')),
	CONSTRAINT "mocco_changelog_entries_tags_check" CHECK ("mocco_changelog_entries"."tags" <@ ARRAY['new','improved','fixed']::text[]),
	CONSTRAINT "mocco_changelog_entries_times_check" CHECK (("mocco_changelog_entries"."publish_at" IS NOT NULL) = ("mocco_changelog_entries"."state" = 'scheduled')
        AND ("mocco_changelog_entries"."published_at" IS NOT NULL) = ("mocco_changelog_entries"."state" = 'published'))
);
--> statement-breakpoint
CREATE TABLE "mocco_changelog_entry_posts" (
	"entry_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "mocco_changelog_entry_posts_pk" PRIMARY KEY("entry_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "mocco_changelog_entries" ADD CONSTRAINT "mocco_changelog_entries_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_changelog_entries" ADD CONSTRAINT "mocco_changelog_entries_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_changelog_entry_posts" ADD CONSTRAINT "mocco_changelog_entry_posts_entry_fk" FOREIGN KEY ("entry_id","workspace_id") REFERENCES "public"."mocco_changelog_entries"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_changelog_entry_posts" ADD CONSTRAINT "mocco_changelog_entry_posts_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_changelog_entries_board_slug_uq" ON "mocco_changelog_entries" USING btree ("board_id","slug");--> statement-breakpoint
CREATE INDEX "mocco_changelog_entries_board_state_published_idx" ON "mocco_changelog_entries" USING btree ("board_id","state","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_changelog_entries_due_idx" ON "mocco_changelog_entries" USING btree ("publish_at") WHERE "mocco_changelog_entries"."state" = 'scheduled';--> statement-breakpoint
CREATE INDEX "mocco_changelog_entry_posts_post_idx" ON "mocco_changelog_entry_posts" USING btree ("post_id");