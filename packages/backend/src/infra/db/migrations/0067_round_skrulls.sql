CREATE TABLE "mocco_status_component_days" (
	"component_id" uuid NOT NULL,
	"day" date NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worst_status" text NOT NULL,
	"down_seconds" integer NOT NULL,
	"uptime_ratio" numeric(7, 6),
	"incident_ids" uuid[] NOT NULL,
	CONSTRAINT "mocco_status_component_days_pk" PRIMARY KEY("component_id","day"),
	CONSTRAINT "mocco_status_component_days_worst_status_check" CHECK ("mocco_status_component_days"."worst_status" IN ('operational','maintenance','degraded','partial_outage','major_outage'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_rollups_daily" (
	"monitor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rounds" integer NOT NULL,
	"ok_rounds" integer NOT NULL,
	"down_seconds" integer NOT NULL,
	"maintenance_seconds" integer NOT NULL,
	"uptime_ratio" numeric(7, 6),
	"latency_hist" integer[] NOT NULL,
	"p95_ms" integer,
	CONSTRAINT "mocco_status_rollups_daily_pk" PRIMARY KEY("monitor_id","day")
);
--> statement-breakpoint
CREATE TABLE "mocco_status_rollups_hourly" (
	"monitor_id" uuid NOT NULL,
	"hour" timestamp NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rounds" integer NOT NULL,
	"ok_rounds" integer NOT NULL,
	"fail_rounds" integer NOT NULL,
	"unknown_rounds" integer NOT NULL,
	"down_seconds" integer NOT NULL,
	"latency_sum_ms" bigint NOT NULL,
	"latency_count" integer NOT NULL,
	"latency_hist" integer[] NOT NULL,
	CONSTRAINT "mocco_status_rollups_hourly_pk" PRIMARY KEY("monitor_id","hour")
);
--> statement-breakpoint
ALTER TABLE "mocco_status_component_days" ADD CONSTRAINT "mocco_status_component_days_component_fk" FOREIGN KEY ("component_id","workspace_id") REFERENCES "public"."mocco_status_components"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_rollups_daily" ADD CONSTRAINT "mocco_status_rollups_daily_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_rollups_hourly" ADD CONSTRAINT "mocco_status_rollups_hourly_monitor_fk" FOREIGN KEY ("monitor_id","workspace_id") REFERENCES "public"."mocco_status_monitors"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_rollups_hourly_hour_idx" ON "mocco_status_rollups_hourly" USING btree ("hour");