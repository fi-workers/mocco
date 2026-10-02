CREATE TABLE "mocco_ota_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_app_id" uuid NOT NULL,
	"protocol" text DEFAULT 'expo_updates' NOT NULL,
	"asset_base_url" text NOT NULL,
	"signing_required" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_apps_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_ota_apps_protocol_check" CHECK ("mocco_ota_apps"."protocol" IN ('expo_updates'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_assets" (
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"content_type" text NOT NULL,
	"file_extension" text,
	"size_bytes" bigint NOT NULL,
	"object_id" uuid,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_assets_pk" PRIMARY KEY("app_id","hash")
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_channel_heads" (
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"runtime_version" text NOT NULL,
	"active_update_id" uuid,
	"candidate_update_id" uuid,
	"rollout_bp" smallint DEFAULT 0 NOT NULL,
	"rollout_salt" text NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"serve_directive_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_channel_heads_pk" PRIMARY KEY("channel_id","platform","runtime_version"),
	CONSTRAINT "mocco_ota_channel_heads_rollout_check" CHECK ("mocco_ota_channel_heads"."rollout_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "mocco_ota_channel_heads_platform_check" CHECK ("mocco_ota_channel_heads"."platform" IN ('ios','android'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_protected" boolean DEFAULT false NOT NULL,
	"policy" jsonb,
	"access_key_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_channels_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_ota_channels_policy_check" CHECK (("mocco_ota_channels"."is_protected") = ("mocco_ota_channels"."policy" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"release_id" uuid,
	"kind" text NOT NULL,
	"from_bp" smallint,
	"to_bp" smallint,
	"actor_user_id" uuid,
	"actor_principal" text,
	"approval_request_id" uuid,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_deployments_kind_check" CHECK ("mocco_ota_deployments"."kind" IN ('promote','rollout','pause','resume','complete','rollback','rollback_embedded','disable'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"runtime_version" text NOT NULL,
	"message" text,
	"git_sha" text,
	"uploaded_by_user_id" uuid,
	"uploaded_by_principal" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_releases_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_ota_releases_status_check" CHECK ("mocco_ota_releases"."status" IN ('uploading','verifying','ready','failed','disabled'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_signed_directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"release_id" uuid,
	"platform" text NOT NULL,
	"runtime_version" text NOT NULL,
	"type" text NOT NULL,
	"commit_time" timestamp with time zone,
	"supersedes_update_id" uuid,
	"body" text NOT NULL,
	"signature" text,
	"keyid" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_signed_directives_type_check" CHECK ("mocco_ota_signed_directives"."type" IN ('noUpdateAvailable','rollBackToEmbedded')),
	CONSTRAINT "mocco_ota_signed_directives_platform_check" CHECK ("mocco_ota_signed_directives"."platform" IN ('ios','android'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_signing_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"keyid" text NOT NULL,
	"certificate_pem" text NOT NULL,
	"spki_sha256" text NOT NULL,
	"subject" text NOT NULL,
	"not_after" timestamp NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_signing_certificates_status_check" CHECK ("mocco_ota_signing_certificates"."status" IN ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_update_assets" (
	"update_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"asset_hash" text NOT NULL,
	"key" text NOT NULL,
	"is_launch" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mocco_ota_update_assets_pk" PRIMARY KEY("update_id","asset_hash")
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"runtime_version" text NOT NULL,
	"kind" text NOT NULL,
	"content_of_update_id" uuid NOT NULL,
	"supersedes_update_id" uuid,
	"commit_time" timestamp with time zone NOT NULL,
	"manifest_body" text NOT NULL,
	"signature" text,
	"keyid" text,
	"launch_asset_hash" text NOT NULL,
	"total_bytes" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_updates_release_platform_kind_uq" UNIQUE NULLS NOT DISTINCT("release_id","platform","kind","supersedes_update_id"),
	CONSTRAINT "mocco_ota_updates_platform_check" CHECK ("mocco_ota_updates"."platform" IN ('ios','android')),
	CONSTRAINT "mocco_ota_updates_kind_check" CHECK ("mocco_ota_updates"."kind" IN ('original','republish'))
);
--> statement-breakpoint
ALTER TABLE "mocco_ota_apps" ADD CONSTRAINT "mocco_ota_apps_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_apps" ADD CONSTRAINT "mocco_ota_apps_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_apps" ADD CONSTRAINT "mocco_ota_apps_project_app_workspace_fk" FOREIGN KEY ("project_app_id","workspace_id") REFERENCES "public"."mocco_project_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_assets" ADD CONSTRAINT "mocco_ota_assets_object_id_mocco_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."mocco_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_assets" ADD CONSTRAINT "mocco_ota_assets_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_channel_heads" ADD CONSTRAINT "mocco_ota_channel_heads_active_update_id_mocco_ota_updates_id_fk" FOREIGN KEY ("active_update_id") REFERENCES "public"."mocco_ota_updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_channel_heads" ADD CONSTRAINT "mocco_ota_channel_heads_candidate_update_id_mocco_ota_updates_id_fk" FOREIGN KEY ("candidate_update_id") REFERENCES "public"."mocco_ota_updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_channel_heads" ADD CONSTRAINT "mocco_ota_channel_heads_serve_directive_id_mocco_ota_signed_directives_id_fk" FOREIGN KEY ("serve_directive_id") REFERENCES "public"."mocco_ota_signed_directives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_channel_heads" ADD CONSTRAINT "mocco_ota_channel_heads_channel_fk" FOREIGN KEY ("channel_id","workspace_id") REFERENCES "public"."mocco_ota_channels"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_channels" ADD CONSTRAINT "mocco_ota_channels_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_deployments" ADD CONSTRAINT "mocco_ota_deployments_release_id_mocco_ota_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."mocco_ota_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_deployments" ADD CONSTRAINT "mocco_ota_deployments_actor_user_id_mocco_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_deployments" ADD CONSTRAINT "mocco_ota_deployments_approval_request_id_mocco_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."mocco_approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_deployments" ADD CONSTRAINT "mocco_ota_deployments_channel_fk" FOREIGN KEY ("channel_id","workspace_id") REFERENCES "public"."mocco_ota_channels"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_releases" ADD CONSTRAINT "mocco_ota_releases_uploaded_by_user_id_mocco_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_releases" ADD CONSTRAINT "mocco_ota_releases_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_signed_directives" ADD CONSTRAINT "mocco_ota_signed_directives_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_signing_certificates" ADD CONSTRAINT "mocco_ota_signing_certificates_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_signing_certificates" ADD CONSTRAINT "mocco_ota_signing_certificates_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_update_assets" ADD CONSTRAINT "mocco_ota_update_assets_update_id_mocco_ota_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."mocco_ota_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_updates" ADD CONSTRAINT "mocco_ota_updates_release_fk" FOREIGN KEY ("release_id","workspace_id") REFERENCES "public"."mocco_ota_releases"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_ota_apps_project_app_uq" ON "mocco_ota_apps" USING btree ("project_app_id");--> statement-breakpoint
CREATE INDEX "mocco_ota_apps_project_idx" ON "mocco_ota_apps" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_ota_channels_app_name_uq" ON "mocco_ota_channels" USING btree ("app_id","name");--> statement-breakpoint
CREATE INDEX "mocco_ota_deployments_channel_idx" ON "mocco_ota_deployments" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "mocco_ota_releases_app_runtime_idx" ON "mocco_ota_releases" USING btree ("app_id","runtime_version","created_at");--> statement-breakpoint
CREATE INDEX "mocco_ota_signed_directives_app_idx" ON "mocco_ota_signed_directives" USING btree ("app_id","platform","runtime_version","type");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_ota_signing_certificates_app_spki_uq" ON "mocco_ota_signing_certificates" USING btree ("app_id","spki_sha256");--> statement-breakpoint
CREATE INDEX "mocco_ota_signing_certificates_app_keyid_idx" ON "mocco_ota_signing_certificates" USING btree ("app_id","keyid");--> statement-breakpoint
CREATE INDEX "mocco_ota_updates_app_platform_runtime_idx" ON "mocco_ota_updates" USING btree ("app_id","platform","runtime_version","commit_time");