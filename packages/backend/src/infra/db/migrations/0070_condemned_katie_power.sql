CREATE TABLE "mocco_status_gate_maintenances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"gate_name" text NOT NULL,
	"title" text NOT NULL,
	"expected_minutes" integer NOT NULL,
	"component_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_gate_maintenances_page_gate_uq" UNIQUE("page_id","gate_name"),
	CONSTRAINT "mocco_status_gate_maintenances_expected_minutes_check" CHECK ("mocco_status_gate_maintenances"."expected_minutes" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD COLUMN "gate_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD COLUMN "overran_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD COLUMN "end_note" text;--> statement-breakpoint
ALTER TABLE "mocco_status_gate_maintenances" ADD CONSTRAINT "mocco_status_gate_maintenances_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_gate_maintenances" ADD CONSTRAINT "mocco_status_gate_maintenances_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_gate_maintenances_project_gate_idx" ON "mocco_status_gate_maintenances" USING btree ("project_id","gate_name");--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD CONSTRAINT "mocco_status_maintenances_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_maintenances" ADD CONSTRAINT "mocco_status_maintenances_gate_id_mocco_run_gates_id_fk" FOREIGN KEY ("gate_id") REFERENCES "public"."mocco_run_gates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_maintenances_run_idx" ON "mocco_status_maintenances" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_maintenances_gate_page_uq" ON "mocco_status_maintenances" USING btree ("gate_id","page_id") WHERE "mocco_status_maintenances"."gate_id" IS NOT NULL;