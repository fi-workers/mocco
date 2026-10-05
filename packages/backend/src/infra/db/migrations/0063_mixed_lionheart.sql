CREATE TABLE "mocco_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"repo_id" uuid,
	"commit_sha" text NOT NULL,
	"gates" jsonb NOT NULL,
	"released_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_releases" ADD CONSTRAINT "mocco_releases_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_releases" ADD CONSTRAINT "mocco_releases_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_releases" ADD CONSTRAINT "mocco_releases_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_releases_project_run_uq" ON "mocco_releases" USING btree ("project_id","run_id");--> statement-breakpoint
CREATE INDEX "mocco_releases_project_released_at_idx" ON "mocco_releases" USING btree ("project_id","released_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_releases_repo_released_at_idx" ON "mocco_releases" USING btree ("repo_id","released_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_releases_run_idx" ON "mocco_releases" USING btree ("run_id");