CREATE TABLE "mocco_status_incident_monitors" (
	"incident_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_incident_monitors_pk" PRIMARY KEY("incident_id","monitor_id")
);
--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "incident_policy" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_monitors" ADD CONSTRAINT "mocco_status_incident_monitors_incident_fk" FOREIGN KEY ("incident_id","workspace_id") REFERENCES "public"."mocco_status_incidents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_monitors" ADD CONSTRAINT "mocco_status_incident_monitors_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_incident_monitors_open_uq" ON "mocco_status_incident_monitors" USING btree ("monitor_id") WHERE "mocco_status_incident_monitors"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_incident_policy_check" CHECK ("mocco_status_monitors"."incident_policy" IN ('none','draft','publish'));