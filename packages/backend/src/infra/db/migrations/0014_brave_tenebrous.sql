ALTER TABLE "mocco_project_apps" ADD CONSTRAINT "mocco_project_apps_id_workspace_uq" UNIQUE("id","workspace_id");
--> statement-breakpoint
CREATE TABLE "mocco_app_version_policies" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"min_supported_version" text,
	"recommended_version" text,
	"blocked_versions" text[] DEFAULT '{}'::text[] NOT NULL,
	"messages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"store_url" text,
	"soft_prompt_interval_hours" integer DEFAULT 72 NOT NULL,
	"approval_policy" jsonb,
	"revision" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_app_version_policies_interval_check" CHECK ("mocco_app_version_policies"."soft_prompt_interval_hours" BETWEEN 1 AND 8760),
	CONSTRAINT "mocco_app_version_policies_revision_check" CHECK ("mocco_app_version_policies"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mocco_app_version_policy_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"direction" text NOT NULL,
	"actor_user_id" uuid,
	"approval_request_id" uuid,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_app_version_policy_changes_direction_check" CHECK ("mocco_app_version_policy_changes"."direction" IN ('tighten','relax','none'))
);
--> statement-breakpoint
ALTER TABLE "mocco_app_version_policies" ADD CONSTRAINT "mocco_app_version_policies_app_workspace_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_project_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mocco_app_version_policies" ADD CONSTRAINT "mocco_app_version_policies_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mocco_app_version_policy_changes" ADD CONSTRAINT "mocco_app_version_policy_changes_actor_user_id_mocco_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mocco_app_version_policy_changes" ADD CONSTRAINT "mocco_app_version_policy_changes_approval_request_id_mocco_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."mocco_approval_requests"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mocco_app_version_policy_changes" ADD CONSTRAINT "mocco_app_version_policy_changes_app_workspace_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_project_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "mocco_app_version_policy_changes_app_idx" ON "mocco_app_version_policy_changes" USING btree ("app_id","created_at");
