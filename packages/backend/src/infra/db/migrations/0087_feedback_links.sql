CREATE TABLE "mocco_feedback_link_closers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"external_node_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"merge_commit_sha" text,
	"merged_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_link_closers_state_check" CHECK ("mocco_feedback_link_closers"."state" IN ('open','closed','merged'))
);
--> statement-breakpoint
CREATE TABLE "mocco_feedback_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_number" integer NOT NULL,
	"external_node_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"merge_commit_sha" text,
	"merged_at" timestamp,
	"created_by_user_id" uuid,
	"refreshed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_links_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_feedback_links_kind_check" CHECK ("mocco_feedback_links"."kind" IN ('issue','pull_request')),
	CONSTRAINT "mocco_feedback_links_state_check" CHECK ("mocco_feedback_links"."state" IN ('open','closed','merged')),
	CONSTRAINT "mocco_feedback_links_number_check" CHECK ("mocco_feedback_links"."external_number" > 0),
	CONSTRAINT "mocco_feedback_links_merged_check" CHECK ("mocco_feedback_links"."state" <> 'merged' OR "mocco_feedback_links"."kind" = 'pull_request')
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_link_closers" ADD CONSTRAINT "mocco_feedback_link_closers_link_fk" FOREIGN KEY ("link_id","workspace_id") REFERENCES "public"."mocco_feedback_links"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_link_closers" ADD CONSTRAINT "mocco_feedback_link_closers_repo_workspace_fk" FOREIGN KEY ("repo_id","workspace_id") REFERENCES "public"."mocco_repos"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD CONSTRAINT "mocco_feedback_links_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD CONSTRAINT "mocco_feedback_links_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD CONSTRAINT "mocco_feedback_links_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD CONSTRAINT "mocco_feedback_links_repo_workspace_fk" FOREIGN KEY ("repo_id","workspace_id") REFERENCES "public"."mocco_repos"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_link_closers_link_pr_uq" ON "mocco_feedback_link_closers" USING btree ("link_id","pr_number");--> statement-breakpoint
CREATE INDEX "mocco_feedback_link_closers_repo_pr_idx" ON "mocco_feedback_link_closers" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_links_post_target_uq" ON "mocco_feedback_links" USING btree ("post_id","repo_id","kind","external_number");--> statement-breakpoint
CREATE INDEX "mocco_feedback_links_target_idx" ON "mocco_feedback_links" USING btree ("repo_id","kind","external_number");--> statement-breakpoint
CREATE INDEX "mocco_feedback_links_refreshed_idx" ON "mocco_feedback_links" USING btree ("refreshed_at");