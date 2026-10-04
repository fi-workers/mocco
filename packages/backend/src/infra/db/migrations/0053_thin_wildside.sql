CREATE TABLE "mocco_status_incident_components" (
	"incident_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"impact" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_incident_components_pk" PRIMARY KEY("incident_id","component_id"),
	CONSTRAINT "mocco_status_incident_components_impact_check" CHECK ("mocco_status_incident_components"."impact" IN ('degraded','partial_outage','major_outage'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_incident_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text NOT NULL,
	"body_md" text NOT NULL,
	"author_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_incident_updates_status_check" CHECK ("mocco_status_incident_updates"."status" IN ('investigating','identified','monitoring','resolved'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"identified_at" timestamp,
	"resolved_at" timestamp,
	"postmortem_md" text,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_incidents_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_status_incidents_status_check" CHECK ("mocco_status_incidents"."status" IN ('investigating','identified','monitoring','resolved')),
	CONSTRAINT "mocco_status_incidents_severity_check" CHECK ("mocco_status_incidents"."severity" IN ('minor','major','critical')),
	CONSTRAINT "mocco_status_incidents_resolved_check" CHECK (("mocco_status_incidents"."status" IN ('resolved')) = ("mocco_status_incidents"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_maintenance_components" (
	"maintenance_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_maintenance_components_pk" PRIMARY KEY("maintenance_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_status_maintenances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_start" timestamp NOT NULL,
	"scheduled_end" timestamp NOT NULL,
	"actual_start" timestamp,
	"actual_end" timestamp,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_maintenances_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_status_maintenances_status_check" CHECK ("mocco_status_maintenances"."status" IN ('scheduled','in_progress','completed','canceled')),
	CONSTRAINT "mocco_status_maintenances_window_check" CHECK ("mocco_status_maintenances"."scheduled_end" > "mocco_status_maintenances"."scheduled_start")
);
--> statement-breakpoint
ALTER TABLE "mocco_status_incident_components" ADD CONSTRAINT "mocco_status_incident_components_incident_fk" FOREIGN KEY ("incident_id","workspace_id") REFERENCES "public"."mocco_status_incidents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_components" ADD CONSTRAINT "mocco_status_incident_components_component_fk" FOREIGN KEY ("component_id","workspace_id") REFERENCES "public"."mocco_status_components"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_updates" ADD CONSTRAINT "mocco_status_incident_updates_author_user_id_mocco_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_updates" ADD CONSTRAINT "mocco_status_incident_updates_incident_fk" FOREIGN KEY ("incident_id","workspace_id") REFERENCES "public"."mocco_status_incidents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD CONSTRAINT "mocco_status_incidents_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD CONSTRAINT "mocco_status_incidents_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenance_components" ADD CONSTRAINT "mocco_status_maintenance_components_maintenance_fk" FOREIGN KEY ("maintenance_id","workspace_id") REFERENCES "public"."mocco_status_maintenances"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenance_components" ADD CONSTRAINT "mocco_status_maintenance_components_component_fk" FOREIGN KEY ("component_id","workspace_id") REFERENCES "public"."mocco_status_components"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD CONSTRAINT "mocco_status_maintenances_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD CONSTRAINT "mocco_status_maintenances_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_incident_components_component_idx" ON "mocco_status_incident_components" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "mocco_status_incident_updates_incident_idx" ON "mocco_status_incident_updates" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "mocco_status_incidents_workspace_status_idx" ON "mocco_status_incidents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "mocco_status_incidents_page_started_idx" ON "mocco_status_incidents" USING btree ("page_id","started_at");--> statement-breakpoint
CREATE INDEX "mocco_status_maintenance_components_component_idx" ON "mocco_status_maintenance_components" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "mocco_status_maintenances_page_start_idx" ON "mocco_status_maintenances" USING btree ("page_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "mocco_status_maintenances_due_idx" ON "mocco_status_maintenances" USING btree ("scheduled_start","scheduled_end") WHERE "mocco_status_maintenances"."status" IN ('scheduled','in_progress');