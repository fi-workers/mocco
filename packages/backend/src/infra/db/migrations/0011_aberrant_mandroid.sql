CREATE TABLE "mocco_audit_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_audit_log_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "mocco_audit_log" ADD CONSTRAINT "mocco_audit_log_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_audit_log" ADD CONSTRAINT "mocco_audit_log_actor_user_id_mocco_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_audit_log_workspace_seq_idx" ON "mocco_audit_log" USING btree ("workspace_id","seq");