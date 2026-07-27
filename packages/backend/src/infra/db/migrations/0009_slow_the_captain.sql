CREATE TABLE "mocco_resumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_gate_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_resumes_decision_check" CHECK ("mocco_resumes"."decision" IN ('resume','reject'))
);
--> statement-breakpoint
CREATE TABLE "mocco_run_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_index" integer NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requirements" jsonb NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_run_gates_state_check" CHECK ("mocco_run_gates"."state" IN ('pending','resumed','rejected','expired'))
);
--> statement-breakpoint
ALTER TABLE "mocco_runs" DROP CONSTRAINT "mocco_runs_state_check";--> statement-breakpoint
ALTER TABLE "mocco_resumes" ADD CONSTRAINT "mocco_resumes_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_resumes" ADD CONSTRAINT "mocco_resumes_run_gate_id_mocco_run_gates_id_fk" FOREIGN KEY ("run_gate_id") REFERENCES "public"."mocco_run_gates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_resumes" ADD CONSTRAINT "mocco_resumes_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_resumes" ADD CONSTRAINT "mocco_resumes_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_resumes" ADD CONSTRAINT "mocco_resumes_role_id_mocco_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."mocco_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_run_gates" ADD CONSTRAINT "mocco_run_gates_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_run_gates" ADD CONSTRAINT "mocco_run_gates_run_id_mocco_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mocco_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_resumes_gate_user_uq" ON "mocco_resumes" USING btree ("run_gate_id","user_id");--> statement-breakpoint
CREATE INDEX "mocco_resumes_run_id_idx" ON "mocco_resumes" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_run_gates_run_item_uq" ON "mocco_run_gates" USING btree ("run_id","item_index");--> statement-breakpoint
ALTER TABLE "mocco_runs" ADD CONSTRAINT "mocco_runs_state_check" CHECK ("mocco_runs"."state" IN ('queued','running','succeeded','failed','canceled','awaiting_gate','rejected'));