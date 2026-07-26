CREATE TABLE "mocco_run_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"name" text NOT NULL,
	"executor" text NOT NULL,
	"with" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"handle" text,
	"logs_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_run_steps_status_check" CHECK ("mocco_run_steps"."status" IN ('pending','dispatched','running','succeeded','failed','skipped','canceled'))
);
--> statement-breakpoint
CREATE TABLE "mocco_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"commit_id" uuid NOT NULL,
	"commit_config_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"current_index" integer DEFAULT 0 NOT NULL,
	"callback_token_hash" text NOT NULL,
	"triggered_by_user_id" uuid,
	"trigger_source" text DEFAULT 'manual' NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_runs_state_check" CHECK ("mocco_runs"."state" IN ('queued','running','succeeded','failed','canceled'))
);
--> statement-breakpoint
ALTER TABLE "mocco_run_events" ADD CONSTRAINT "mocco_run_events_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_run_events" ADD CONSTRAINT "mocco_run_events_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_run_steps" ADD CONSTRAINT "mocco_run_steps_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_run_steps" ADD CONSTRAINT "mocco_run_steps_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_runs" ADD CONSTRAINT "mocco_runs_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_runs" ADD CONSTRAINT "mocco_runs_commit_id_mocco_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."mocco_commits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_runs" ADD CONSTRAINT "mocco_runs_commit_config_id_mocco_commit_configs_id_fk" FOREIGN KEY ("commit_config_id") REFERENCES "public"."mocco_commit_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_runs" ADD CONSTRAINT "mocco_runs_triggered_by_user_id_mocco_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_run_events_run_seq_idx" ON "mocco_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_run_steps_run_step_uq" ON "mocco_run_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "mocco_runs_workspace_state_idx" ON "mocco_runs" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "mocco_runs_commit_idx" ON "mocco_runs" USING btree ("commit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_runs_callback_token_hash_uq" ON "mocco_runs" USING btree ("callback_token_hash");