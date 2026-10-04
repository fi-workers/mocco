CREATE TABLE "mocco_status_component_monitors" (
	"component_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"impact_when_down" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_component_monitors_pk" PRIMARY KEY("component_id","monitor_id"),
	CONSTRAINT "mocco_status_component_monitors_impact_check" CHECK ("mocco_status_component_monitors"."impact_when_down" IN ('degraded','partial_outage','major_outage'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp,
	"agent_version" text,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_locations_kind_check" CHECK ("mocco_status_locations"."kind" IN ('hosted','private','embedded')),
	CONSTRAINT "mocco_status_locations_scope_check" CHECK (("mocco_status_locations"."kind" IN ('private')) = ("mocco_status_locations"."workspace_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_monitor_locations" (
	"monitor_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_monitor_locations_pk" PRIMARY KEY("monitor_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_status_monitor_state_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"at" timestamp NOT NULL,
	"round_at" timestamp,
	"reason" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "mocco_status_monitor_state_changes_from_check" CHECK ("mocco_status_monitor_state_changes"."from_state" IN ('pending','up','suspect','down','recovering','degraded','paused')),
	CONSTRAINT "mocco_status_monitor_state_changes_to_check" CHECK ("mocco_status_monitor_state_changes"."to_state" IN ('pending','up','suspect','down','recovering','degraded','paused'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"interval_s" integer NOT NULL,
	"confirmations" integer NOT NULL,
	"recovery_confirmations" integer NOT NULL,
	"quorum_mode" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"state_changed_at" timestamp DEFAULT now() NOT NULL,
	"next_round_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_monitors_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_status_monitors_kind_check" CHECK ("mocco_status_monitors"."kind" IN ('http','tcp')),
	CONSTRAINT "mocco_status_monitors_state_check" CHECK ("mocco_status_monitors"."state" IN ('pending','up','suspect','down','recovering','degraded','paused')),
	CONSTRAINT "mocco_status_monitors_quorum_mode_check" CHECK ("mocco_status_monitors"."quorum_mode" IN ('majority','any','all')),
	CONSTRAINT "mocco_status_monitors_interval_check" CHECK ("mocco_status_monitors"."interval_s" >= 60),
	CONSTRAINT "mocco_status_monitors_confirmations_check" CHECK ("mocco_status_monitors"."confirmations" >= 1 AND "mocco_status_monitors"."recovery_confirmations" >= 1)
);
--> statement-breakpoint
ALTER TABLE "mocco_status_component_monitors" ADD CONSTRAINT "mocco_status_component_monitors_component_fk" FOREIGN KEY ("component_id","workspace_id") REFERENCES "public"."mocco_status_components"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_component_monitors" ADD CONSTRAINT "mocco_status_component_monitors_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_locations" ADD CONSTRAINT "mocco_status_locations_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitor_locations" ADD CONSTRAINT "mocco_status_monitor_locations_location_id_mocco_status_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."mocco_status_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitor_locations" ADD CONSTRAINT "mocco_status_monitor_locations_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitor_state_changes" ADD CONSTRAINT "mocco_status_monitor_state_changes_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_component_monitors_monitor_idx" ON "mocco_status_component_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_locations_token_hash_uq" ON "mocco_status_locations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_locations_workspace_code_uq" ON "mocco_status_locations" USING btree ("workspace_id","code") WHERE "mocco_status_locations"."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_locations_global_code_uq" ON "mocco_status_locations" USING btree ("code") WHERE "mocco_status_locations"."workspace_id" IS NULL;--> statement-breakpoint
CREATE INDEX "mocco_status_monitor_locations_location_idx" ON "mocco_status_monitor_locations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "mocco_status_monitor_state_changes_monitor_at_idx" ON "mocco_status_monitor_state_changes" USING btree ("monitor_id","at");--> statement-breakpoint
CREATE INDEX "mocco_status_monitors_project_idx" ON "mocco_status_monitors" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "mocco_status_monitors_next_round_idx" ON "mocco_status_monitors" USING btree ("next_round_at") WHERE "mocco_status_monitors"."state" NOT IN ('paused');