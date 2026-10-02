CREATE TABLE "mocco_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "mocco_api_keys_kind_check" CHECK ("mocco_api_keys"."kind" IN ('publishable','secret'))
);
--> statement-breakpoint
CREATE TABLE "mocco_rate_limit_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "mocco_rate_limit_counters_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "mocco_api_keys" ADD CONSTRAINT "mocco_api_keys_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_api_keys" ADD CONSTRAINT "mocco_api_keys_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_api_keys_token_hash_uq" ON "mocco_api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mocco_api_keys_project_idx" ON "mocco_api_keys" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "mocco_rate_limit_counters_window_idx" ON "mocco_rate_limit_counters" USING btree ("window_start");