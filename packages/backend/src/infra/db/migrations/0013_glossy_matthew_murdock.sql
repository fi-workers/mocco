CREATE TABLE "mocco_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requirements" jsonb NOT NULL,
	"requested_by_user_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_approval_requests_kind_check" CHECK ("mocco_approval_requests"."kind" IN ('pre_approval','review')),
	CONSTRAINT "mocco_approval_requests_state_check" CHECK ("mocco_approval_requests"."state" IN ('pending','approved','rejected','expired','superseded'))
);
--> statement-breakpoint
CREATE TABLE "mocco_approval_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_approval_votes_decision_check" CHECK ("mocco_approval_votes"."decision" IN ('approve','reject'))
);
--> statement-breakpoint
ALTER TABLE "mocco_approval_requests" ADD CONSTRAINT "mocco_approval_requests_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_approval_requests" ADD CONSTRAINT "mocco_approval_requests_requested_by_user_id_mocco_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_approval_votes" ADD CONSTRAINT "mocco_approval_votes_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_approval_votes" ADD CONSTRAINT "mocco_approval_votes_request_id_mocco_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."mocco_approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_approval_votes" ADD CONSTRAINT "mocco_approval_votes_user_id_mocco_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mocco_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_approval_votes" ADD CONSTRAINT "mocco_approval_votes_role_id_mocco_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."mocco_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_approval_requests_workspace_state_idx" ON "mocco_approval_requests" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
CREATE INDEX "mocco_approval_requests_subject_idx" ON "mocco_approval_requests" USING btree ("workspace_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_approval_votes_request_user_uq" ON "mocco_approval_votes" USING btree ("request_id","user_id");