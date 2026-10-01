CREATE TABLE "mocco_flag_changesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"ops" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"base_version" integer NOT NULL,
	"applied_version" integer,
	"proposed_by_user_id" uuid,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	CONSTRAINT "mocco_flag_changesets_state_check" CHECK ("mocco_flag_changesets"."state" IN ('pending','applied','rejected','conflicted','superseded')),
	CONSTRAINT "mocco_flag_changesets_source_check" CHECK ("mocco_flag_changesets"."source" IN ('ui','repo','api','kill')),
	CONSTRAINT "mocco_flag_changesets_applied_check" CHECK (("mocco_flag_changesets"."state" = 'applied') = ("mocco_flag_changesets"."applied_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mocco_flag_configs" (
	"environment_id" uuid NOT NULL,
	"flag_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"killed" boolean DEFAULT false NOT NULL,
	"default_variant" text NOT NULL,
	"off_variant" text NOT NULL,
	"salt" text DEFAULT md5(random()::text || clock_timestamp()::text) NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "mocco_flag_configs_pk" PRIMARY KEY("environment_id","flag_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_flag_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"change_gate" jsonb,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_flag_environments_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_flag_environments_key_check" CHECK ("mocco_flag_environments"."key" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "mocco_flag_ruleset_snapshots" (
	"environment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"etag" text NOT NULL,
	"document" jsonb NOT NULL,
	"changeset_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_flag_ruleset_snapshots_pk" PRIMARY KEY("environment_id","version")
);
--> statement-breakpoint
CREATE TABLE "mocco_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"variants" jsonb NOT NULL,
	"description" text,
	"lifecycle" text DEFAULT 'temporary' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_flags_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_flags_type_check" CHECK ("mocco_flags"."type" IN ('boolean','string','number','json')),
	CONSTRAINT "mocco_flags_lifecycle_check" CHECK ("mocco_flags"."lifecycle" IN ('temporary','permanent'))
);
--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD CONSTRAINT "mocco_flag_changesets_proposed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD CONSTRAINT "mocco_flag_changesets_environment_fk" FOREIGN KEY ("environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_configs" ADD CONSTRAINT "mocco_flag_configs_environment_fk" FOREIGN KEY ("environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_configs" ADD CONSTRAINT "mocco_flag_configs_flag_fk" FOREIGN KEY ("flag_id","workspace_id") REFERENCES "public"."mocco_flags"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_environments" ADD CONSTRAINT "mocco_flag_environments_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_environments" ADD CONSTRAINT "mocco_flag_environments_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_ruleset_snapshots" ADD CONSTRAINT "mocco_flag_ruleset_snapshots_changeset_id_mocco_flag_changesets_id_fk" FOREIGN KEY ("changeset_id") REFERENCES "public"."mocco_flag_changesets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_ruleset_snapshots" ADD CONSTRAINT "mocco_flag_ruleset_snapshots_environment_fk" FOREIGN KEY ("environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flags" ADD CONSTRAINT "mocco_flags_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flags" ADD CONSTRAINT "mocco_flags_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_flag_changesets_environment_idx" ON "mocco_flag_changesets" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_flag_changesets_applied_version_uq" ON "mocco_flag_changesets" USING btree ("environment_id","applied_version");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_flag_environments_project_key_uq" ON "mocco_flag_environments" USING btree ("project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_flags_project_key_uq" ON "mocco_flags" USING btree ("project_id","key");