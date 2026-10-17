CREATE TABLE "mocco_feedback_mail_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_mail_opt_outs_end_user_check" CHECK (char_length("mocco_feedback_mail_opt_outs"."end_user_id") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_mail_opt_outs" ADD CONSTRAINT "mocco_feedback_mail_opt_outs_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_mail_opt_outs_project_end_user_uq" ON "mocco_feedback_mail_opt_outs" USING btree ("project_id","end_user_id");