CREATE TABLE "mocco_job_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"project_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cron" text,
	"interval_seconds" integer,
	"next_run_at" timestamp NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_enqueued_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_job_schedules_project_check" CHECK ("mocco_job_schedules"."project_id" IS NULL OR "mocco_job_schedules"."workspace_id" IS NOT NULL),
	CONSTRAINT "mocco_job_schedules_timing_check" CHECK (("mocco_job_schedules"."cron" IS NULL) <> ("mocco_job_schedules"."interval_seconds" IS NULL)),
	CONSTRAINT "mocco_job_schedules_interval_check" CHECK ("mocco_job_schedules"."interval_seconds" IS NULL OR "mocco_job_schedules"."interval_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "mocco_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"locked_by" text,
	"dedupe_key" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	CONSTRAINT "mocco_jobs_status_check" CHECK ("mocco_jobs"."status" IN ('queued','running','succeeded','failed','dead')),
	CONSTRAINT "mocco_jobs_attempts_check" CHECK ("mocco_jobs"."attempts" >= 0 AND "mocco_jobs"."max_attempts" >= 1 AND "mocco_jobs"."deferrals" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mocco_job_schedules" ADD CONSTRAINT "mocco_job_schedules_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_job_schedules" ADD CONSTRAINT "mocco_job_schedules_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_jobs" ADD CONSTRAINT "mocco_jobs_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_job_schedules_workspace_idx" ON "mocco_job_schedules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mocco_job_schedules_next_run_at_idx" ON "mocco_job_schedules" USING btree ("next_run_at") WHERE "mocco_job_schedules"."enabled";--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_job_schedules_system_kind_uq" ON "mocco_job_schedules" USING btree ("kind") WHERE "mocco_job_schedules"."workspace_id" IS NULL;--> statement-breakpoint
CREATE INDEX "mocco_jobs_status_run_at_idx" ON "mocco_jobs" USING btree ("status","run_at") WHERE "mocco_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "mocco_jobs_workspace_idx" ON "mocco_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mocco_jobs_locked_until_idx" ON "mocco_jobs" USING btree ("locked_until") WHERE "mocco_jobs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_jobs_kind_dedupe_key_uq" ON "mocco_jobs" USING btree ("kind","dedupe_key") WHERE "mocco_jobs"."dedupe_key" IS NOT NULL AND "mocco_jobs"."status" IN ('queued','running');