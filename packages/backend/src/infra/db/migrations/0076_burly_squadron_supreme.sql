CREATE TABLE "mocco_feedback_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"next_post_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_boards_scope_uq" UNIQUE("id","workspace_id","project_id"),
	CONSTRAINT "mocco_feedback_boards_slug_check" CHECK ("mocco_feedback_boards"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "mocco_feedback_boards_next_post_number_check" CHECK ("mocco_feedback_boards"."next_post_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mocco_feedback_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_categories_id_board_uq" UNIQUE("id","board_id"),
	CONSTRAINT "mocco_feedback_categories_slug_check" CHECK ("mocco_feedback_categories"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "mocco_feedback_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"category_id" uuid,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'under_review' NOT NULL,
	"shipped_at" timestamp,
	"author_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_posts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_feedback_posts_status_check" CHECK ("mocco_feedback_posts"."status" IN ('under_review','planned','in_progress','shipped','closed')),
	CONSTRAINT "mocco_feedback_posts_shipped_check" CHECK (("mocco_feedback_posts"."status" IN ('shipped')) = ("mocco_feedback_posts"."shipped_at" IS NOT NULL)),
	CONSTRAINT "mocco_feedback_posts_number_check" CHECK ("mocco_feedback_posts"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mocco_feedback_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_status_changes_from_check" CHECK ("mocco_feedback_status_changes"."from_status" IS NULL OR "mocco_feedback_status_changes"."from_status" IN ('under_review','planned','in_progress','shipped','closed')),
	CONSTRAINT "mocco_feedback_status_changes_to_check" CHECK ("mocco_feedback_status_changes"."to_status" IN ('under_review','planned','in_progress','shipped','closed')),
	CONSTRAINT "mocco_feedback_status_changes_reason_check" CHECK ("mocco_feedback_status_changes"."reason" IN ('created','manual','ship_suggestion','auto_apply','merge'))
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD CONSTRAINT "mocco_feedback_boards_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_categories" ADD CONSTRAINT "mocco_feedback_categories_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_author_user_id_mocco_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_posts" ADD CONSTRAINT "mocco_feedback_posts_category_fk" FOREIGN KEY ("category_id","board_id") REFERENCES "public"."mocco_feedback_categories"("id","board_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_status_changes" ADD CONSTRAINT "mocco_feedback_status_changes_actor_user_id_mocco_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_status_changes" ADD CONSTRAINT "mocco_feedback_status_changes_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_boards_project_slug_uq" ON "mocco_feedback_boards" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "mocco_feedback_boards_workspace_idx" ON "mocco_feedback_boards" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_categories_board_slug_uq" ON "mocco_feedback_categories" USING btree ("board_id","slug");--> statement-breakpoint
CREATE INDEX "mocco_feedback_categories_board_position_idx" ON "mocco_feedback_categories" USING btree ("board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_posts_board_number_uq" ON "mocco_feedback_posts" USING btree ("board_id","number");--> statement-breakpoint
CREATE INDEX "mocco_feedback_posts_board_status_created_idx" ON "mocco_feedback_posts" USING btree ("board_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_feedback_posts_board_created_idx" ON "mocco_feedback_posts" USING btree ("board_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_feedback_status_changes_post_created_idx" ON "mocco_feedback_status_changes" USING btree ("post_id","created_at");