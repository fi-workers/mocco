ALTER TABLE "mocco_status_incidents" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD COLUMN "suspected_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "watch_until" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "watch_interval_s" integer;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "watch_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD CONSTRAINT "mocco_status_incidents_suspected_run_id_mocco_runs_id_fk" FOREIGN KEY ("suspected_run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_watch_run_id_mocco_runs_id_fk" FOREIGN KEY ("watch_run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD CONSTRAINT "mocco_status_incidents_origin_check" CHECK ("mocco_status_incidents"."origin" IN ('manual','monitor','deploy_watch'));--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_watch_check" CHECK (("mocco_status_monitors"."watch_until" IS NULL) = ("mocco_status_monitors"."watch_interval_s" IS NULL) AND ("mocco_status_monitors"."watch_interval_s" IS NULL OR "mocco_status_monitors"."watch_interval_s" >= 30));