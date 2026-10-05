CREATE TABLE "mocco_status_incident_runs" (
	"incident_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"score" real,
	"linked_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_incident_runs_pk" PRIMARY KEY("incident_id","run_id"),
	CONSTRAINT "mocco_status_incident_runs_relation_check" CHECK ("mocco_status_incident_runs"."relation" IN ('suspected','before_window','fix','manual'))
);
--> statement-breakpoint
ALTER TABLE "mocco_status_incident_runs" ADD CONSTRAINT "mocco_status_incident_runs_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_runs" ADD CONSTRAINT "mocco_status_incident_runs_linked_by_user_id_mocco_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incident_runs" ADD CONSTRAINT "mocco_status_incident_runs_incident_fk" FOREIGN KEY ("incident_id","workspace_id") REFERENCES "public"."mocco_status_incidents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_incident_runs_run_idx" ON "mocco_status_incident_runs" USING btree ("run_id");