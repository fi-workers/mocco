CREATE TABLE "mocco_status_check_results" (
	"monitor_id" uuid NOT NULL,
	"round_at" timestamp NOT NULL,
	"location_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"error_kind" text,
	"status_code" smallint,
	"latency_ms" integer,
	"timings" jsonb,
	"tls_expires_at" timestamp,
	"detail" text,
	"received_at" timestamp NOT NULL,
	CONSTRAINT "mocco_status_check_results_pk" PRIMARY KEY("monitor_id","round_at","location_id"),
	CONSTRAINT "mocco_status_check_results_outcome_check" CHECK ("mocco_status_check_results"."outcome" IN ('ok','fail','no_data')),
	CONSTRAINT "mocco_status_check_results_error_kind_check" CHECK ("mocco_status_check_results"."error_kind" IS NULL OR "mocco_status_check_results"."error_kind" IN ('timeout','dns','connect','tls','status','keyword','latency'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_probe_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"round_at" timestamp NOT NULL,
	"leased_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"reported_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "mocco_status_probe_leases" ADD CONSTRAINT "mocco_status_probe_leases_location_id_mocco_status_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."mocco_status_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_probe_leases" ADD CONSTRAINT "mocco_status_probe_leases_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_check_results_workspace_round_idx" ON "mocco_status_check_results" USING btree ("workspace_id","round_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_probe_leases_monitor_location_round_uq" ON "mocco_status_probe_leases" USING btree ("monitor_id","location_id","round_at");--> statement-breakpoint
CREATE INDEX "mocco_status_probe_leases_location_idx" ON "mocco_status_probe_leases" USING btree ("location_id","round_at");