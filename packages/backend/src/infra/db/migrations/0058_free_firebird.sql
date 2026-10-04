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
);
--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "consecutive_fails" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "consecutive_oks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_status_round_verdicts_workspace_round_idx" ON "mocco_status_round_verdicts" USING btree ("workspace_id","round_at");