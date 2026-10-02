CREATE TABLE "mocco_flag_file_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repo_id" uuid,
	"commit_sha" text NOT NULL,
	"state" text NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_flag_file_syncs_state_check" CHECK ("mocco_flag_file_syncs"."state" IN ('applied','pending_approval','unchanged','invalid'))
);
--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "mocco_flags" ADD COLUMN "managed_by" text DEFAULT 'ui' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_flag_file_syncs" ADD CONSTRAINT "mocco_flag_file_syncs_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_file_syncs" ADD CONSTRAINT "mocco_flag_file_syncs_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_flag_file_syncs_project_idx" ON "mocco_flag_file_syncs" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD CONSTRAINT "mocco_flag_changesets_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_flag_changesets_repo_pending_uq" ON "mocco_flag_changesets" USING btree ("environment_id","repo_id") WHERE "mocco_flag_changesets"."state" = 'pending' AND "mocco_flag_changesets"."repo_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_flags" ADD CONSTRAINT "mocco_flags_managed_by_check" CHECK ("mocco_flags"."managed_by" IN ('ui','repo'));