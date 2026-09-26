CREATE TABLE "mocco_ota_external_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"name" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"secret_fingerprint" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp,
	CONSTRAINT "mocco_ota_external_credentials_tool_check" CHECK ("mocco_ota_external_credentials"."tool" IN ('eas','codepush','hot_updater','generic'))
);
--> statement-breakpoint
ALTER TABLE "mocco_ota_external_credentials" ADD CONSTRAINT "mocco_ota_external_credentials_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_external_credentials" ADD CONSTRAINT "mocco_ota_external_credentials_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_ota_external_credentials_workspace_name_uq" ON "mocco_ota_external_credentials" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "mocco_ota_external_credentials_project_idx" ON "mocco_ota_external_credentials" USING btree ("project_id");