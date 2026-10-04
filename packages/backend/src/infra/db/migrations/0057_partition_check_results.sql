-- Custom SQL migration file, put your code below! --
-- drizzle-kit can't declare a partitioned table, so 0056 created mocco_status_check_results as a
-- plain table (keeping schema.ts, the snapshot and the drift check in step) and this migration
-- recreates it, still empty, as the parent partitioned by day on round_at. Columns, the primary
-- key, the checks and the index are exactly 0056's. The parent holds no rows: the status.retention
-- job creates each day's partition ahead of time and drops the ones past retention.
DROP TABLE "mocco_status_check_results";
--> statement-breakpoint
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
) PARTITION BY RANGE ("round_at");
--> statement-breakpoint
CREATE INDEX "mocco_status_check_results_workspace_round_idx" ON "mocco_status_check_results" USING btree ("workspace_id","round_at");
