CREATE TABLE "mocco_feedback_ship_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"gate_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"changelog_entry_id" uuid,
	"decided_by_user_id" uuid,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_ship_suggestions_state_check" CHECK ("mocco_feedback_ship_suggestions"."state" IN ('pending','accepted','dismissed','auto_applied')),
	CONSTRAINT "mocco_feedback_ship_suggestions_decided_check" CHECK (("mocco_feedback_ship_suggestions"."decided_at" IS NULL) = ("mocco_feedback_ship_suggestions"."state" = 'pending'))
);
--> statement-breakpoint
ALTER TABLE "mocco_changelog_entries" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD COLUMN "release_repo_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD COLUMN "release_step_name" text;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD COLUMN "ship_policy" text DEFAULT 'all_links_shipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD COLUMN "ship_mode" text DEFAULT 'suggest' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD COLUMN "shipped_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD COLUMN "shipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_feedback_ship_suggestions" ADD CONSTRAINT "mocco_feedback_ship_suggestions_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_ship_suggestions" ADD CONSTRAINT "mocco_feedback_ship_suggestions_changelog_entry_id_mocco_changelog_entries_id_fk" FOREIGN KEY ("changelog_entry_id") REFERENCES "public"."mocco_changelog_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_ship_suggestions" ADD CONSTRAINT "mocco_feedback_ship_suggestions_decided_by_user_id_mocco_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_ship_suggestions" ADD CONSTRAINT "mocco_feedback_ship_suggestions_board_fk" FOREIGN KEY ("board_id","workspace_id","project_id") REFERENCES "public"."mocco_feedback_boards"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_ship_suggestions" ADD CONSTRAINT "mocco_feedback_ship_suggestions_post_fk" FOREIGN KEY ("post_id","workspace_id") REFERENCES "public"."mocco_feedback_posts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_ship_suggestions_post_run_uq" ON "mocco_feedback_ship_suggestions" USING btree ("post_id","run_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_ship_suggestions_board_pending_idx" ON "mocco_feedback_ship_suggestions" USING btree ("board_id","run_id") WHERE "mocco_feedback_ship_suggestions"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "mocco_changelog_entries" ADD CONSTRAINT "mocco_changelog_entries_source_run_id_mocco_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD CONSTRAINT "mocco_feedback_boards_release_repo_id_mocco_repos_id_fk" FOREIGN KEY ("release_repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_feedback_links" ADD CONSTRAINT "mocco_feedback_links_shipped_run_id_mocco_runs_id_fk" FOREIGN KEY ("shipped_run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_changelog_entries_board_source_run_uq" ON "mocco_changelog_entries" USING btree ("board_id","source_run_id") WHERE "mocco_changelog_entries"."source_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_feedback_boards_release_repo_idx" ON "mocco_feedback_boards" USING btree ("release_repo_id") WHERE "mocco_feedback_boards"."release_repo_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_feedback_links_unshipped_idx" ON "mocco_feedback_links" USING btree ("repo_id") WHERE "mocco_feedback_links"."shipped_run_id" IS NULL;--> statement-breakpoint
CREATE INDEX "mocco_feedback_links_shipped_run_idx" ON "mocco_feedback_links" USING btree ("shipped_run_id") WHERE "mocco_feedback_links"."shipped_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD CONSTRAINT "mocco_feedback_boards_ship_policy_check" CHECK ("mocco_feedback_boards"."ship_policy" IN ('all_links_shipped','any_link_shipped'));--> statement-breakpoint
ALTER TABLE "mocco_feedback_boards" ADD CONSTRAINT "mocco_feedback_boards_ship_mode_check" CHECK ("mocco_feedback_boards"."ship_mode" IN ('suggest','auto_apply'));