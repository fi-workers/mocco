CREATE TABLE "mocco_ota_trust_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"provider" text DEFAULT 'github' NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository" text NOT NULL,
	"ref_pattern" text NOT NULL,
	"workflow_ref" text,
	"environment" text,
	"allowed_channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_trust_policies_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD COLUMN "trust_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD COLUMN "allowed_channels" text[];--> statement-breakpoint
ALTER TABLE "mocco_ota_trust_policies" ADD CONSTRAINT "mocco_ota_trust_policies_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_trust_policies" ADD CONSTRAINT "mocco_ota_trust_policies_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_ota_trust_policies_app_idx" ON "mocco_ota_trust_policies" USING btree ("app_id","repository_id");--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD CONSTRAINT "mocco_ota_upload_sessions_trust_policy_id_mocco_ota_trust_policies_id_fk" FOREIGN KEY ("trust_policy_id") REFERENCES "public"."mocco_ota_trust_policies"("id") ON DELETE set null ON UPDATE no action;