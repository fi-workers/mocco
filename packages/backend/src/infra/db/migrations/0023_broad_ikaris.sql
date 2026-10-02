CREATE TABLE "mocco_ota_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"principal" text NOT NULL,
	"api_key_id" uuid,
	"release_id" uuid,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_upload_sessions_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mocco_ota_assets" DROP CONSTRAINT "mocco_ota_assets_object_id_mocco_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD CONSTRAINT "mocco_ota_upload_sessions_api_key_id_mocco_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."mocco_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD CONSTRAINT "mocco_ota_upload_sessions_release_id_mocco_ota_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."mocco_ota_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_upload_sessions" ADD CONSTRAINT "mocco_ota_upload_sessions_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_ota_upload_sessions_expires_idx" ON "mocco_ota_upload_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "mocco_ota_assets" ADD CONSTRAINT "mocco_ota_assets_object_id_mocco_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."mocco_objects"("id") ON DELETE set null ON UPDATE no action;