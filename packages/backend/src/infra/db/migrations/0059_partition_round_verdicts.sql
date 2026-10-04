-- Custom SQL migration file, put your code below! --
-- Same pattern as 0057: drizzle-kit can't declare a partitioned table, so 0058 created
-- mocco_status_round_verdicts as a plain table (keeping schema.ts, the snapshot and the drift
-- check in step) and this migration recreates it, still empty, as the parent partitioned by day on
-- round_at. Columns, the primary key, the check and the index are exactly 0058's. The
-- status.retention job creates each day's partition ahead of time and drops the ones past retention.
DROP TABLE "mocco_status_round_verdicts";
--> statement-breakpoint
CREATE TABLE "mocco_status_round_verdicts" (
	"monitor_id" uuid NOT NULL,
	"round_at" timestamp NOT NULL,
	"workspace_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"ok_count" integer NOT NULL,
	"fail_count" integer NOT NULL,
	"no_data_count" integer NOT NULL,
	"p50_latency_ms" integer,
	"closed_at" timestamp NOT NULL,
	CONSTRAINT "mocco_status_round_verdicts_pk" PRIMARY KEY("monitor_id","round_at"),
	CONSTRAINT "mocco_status_round_verdicts_verdict_check" CHECK ("mocco_status_round_verdicts"."verdict" IN ('ok','degraded','fail','unknown'))
) PARTITION BY RANGE ("round_at");
--> statement-breakpoint
CREATE INDEX "mocco_status_round_verdicts_workspace_round_idx" ON "mocco_status_round_verdicts" USING btree ("workspace_id","round_at");
