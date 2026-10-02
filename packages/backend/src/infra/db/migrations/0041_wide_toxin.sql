ALTER TABLE "mocco_app_version_policies" RENAME TO "mocco_ota_version_policies";--> statement-breakpoint
ALTER TABLE "mocco_app_version_policy_changes" RENAME TO "mocco_ota_version_policy_changes";--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" DROP CONSTRAINT "mocco_app_version_policies_interval_check";--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" DROP CONSTRAINT "mocco_app_version_policies_revision_check";--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" DROP CONSTRAINT "mocco_app_version_policy_changes_direction_check";--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" DROP CONSTRAINT "mocco_app_version_policies_app_workspace_fk";
--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" DROP CONSTRAINT "mocco_app_version_policies_project_workspace_fk";
--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" DROP CONSTRAINT "mocco_app_version_policy_changes_actor_user_id_mocco_users_id_fk";
--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" DROP CONSTRAINT "mocco_app_version_policy_changes_approval_request_id_mocco_approval_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" DROP CONSTRAINT "mocco_app_version_policy_changes_app_workspace_fk";
--> statement-breakpoint
DROP INDEX "mocco_app_version_policy_changes_app_idx";--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" ADD CONSTRAINT "mocco_ota_version_policies_app_workspace_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_project_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" ADD CONSTRAINT "mocco_ota_version_policies_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" ADD CONSTRAINT "mocco_ota_version_policy_changes_actor_user_id_mocco_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" ADD CONSTRAINT "mocco_ota_version_policy_changes_approval_request_id_mocco_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."mocco_approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" ADD CONSTRAINT "mocco_ota_version_policy_changes_app_workspace_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_project_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_ota_version_policy_changes_app_idx" ON "mocco_ota_version_policy_changes" USING btree ("app_id","created_at");--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" ADD CONSTRAINT "mocco_ota_version_policies_interval_check" CHECK ("mocco_ota_version_policies"."soft_prompt_interval_hours" BETWEEN 1 AND 8760);--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policies" ADD CONSTRAINT "mocco_ota_version_policies_revision_check" CHECK ("mocco_ota_version_policies"."revision" >= 1);--> statement-breakpoint
ALTER TABLE "mocco_ota_version_policy_changes" ADD CONSTRAINT "mocco_ota_version_policy_changes_direction_check" CHECK ("mocco_ota_version_policy_changes"."direction" IN ('tighten','relax','none'));