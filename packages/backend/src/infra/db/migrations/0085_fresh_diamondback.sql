CREATE TABLE "mocco_feedback_post_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"excerpt" text NOT NULL,
	"end_user_id" text,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_post_sources_type_check" CHECK ("mocco_feedback_post_sources"."source_type" IN ('messenger_conversation')),
	CONSTRAINT "mocco_feedback_post_sources_excerpt_check" CHECK (char_length("mocco_feedback_post_sources"."excerpt") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_post_sources" ADD CONSTRAINT "mocco_feedback_post_sources_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_post_sources" ADD CONSTRAINT "mocco_feedback_post_sources_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_post_sources" ADD CONSTRAINT "mocco_feedback_post_sources_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_post_sources_source_post_uq" ON "mocco_feedback_post_sources" USING btree ("source_type","source_id","post_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_post_sources_project_source_idx" ON "mocco_feedback_post_sources" USING btree ("project_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_post_sources_post_idx" ON "mocco_feedback_post_sources" USING btree ("post_id");