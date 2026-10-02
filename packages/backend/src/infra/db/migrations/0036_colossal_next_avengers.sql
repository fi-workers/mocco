CREATE TABLE "mocco_flag_eval_rollups" (
	"environment_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"variant" text NOT NULL,
	"bucket_hour" timestamp NOT NULL,
	"workspace_id" uuid NOT NULL,
	"count" bigint NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	CONSTRAINT "mocco_flag_eval_rollups_pk" PRIMARY KEY("environment_id","flag_key","variant","bucket_hour"),
	CONSTRAINT "mocco_flag_eval_rollups_count_check" CHECK ("mocco_flag_eval_rollups"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "mocco_flag_stale_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"flag_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"detected_at" timestamp NOT NULL,
	"last_evaluated_at" timestamp,
	"served_variant" text,
	"dismissed_until" timestamp,
	"dismissed_by_user_id" uuid,
	CONSTRAINT "mocco_flag_stale_findings_kind_check" CHECK ("mocco_flag_stale_findings"."kind" IN ('unused','never_evaluated','fully_rolled_out'))
);
--> statement-breakpoint
ALTER TABLE "mocco_flag_eval_rollups" ADD CONSTRAINT "mocco_flag_eval_rollups_environment_fk" FOREIGN KEY ("environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_stale_findings" ADD CONSTRAINT "mocco_flag_stale_findings_dismissed_by_user_id_mocco_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_flag_stale_findings" ADD CONSTRAINT "mocco_flag_stale_findings_flag_fk" FOREIGN KEY ("flag_id","workspace_id") REFERENCES "public"."mocco_flags"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_flag_eval_rollups_bucket_idx" ON "mocco_flag_eval_rollups" USING btree ("bucket_hour");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_flag_stale_findings_flag_kind_uq" ON "mocco_flag_stale_findings" USING btree ("flag_id","kind");--> statement-breakpoint
CREATE INDEX "mocco_flag_stale_findings_project_idx" ON "mocco_flag_stale_findings" USING btree ("workspace_id","project_id");