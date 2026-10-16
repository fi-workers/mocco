CREATE TABLE "mocco_feedback_status_mails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status_change_id" uuid NOT NULL,
	"end_user_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp,
	"sent_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_feedback_status_mails_state_check" CHECK ("mocco_feedback_status_mails"."state" IN ('queued','sending','sent','failed','skipped'))
);
--> statement-breakpoint
ALTER TABLE "mocco_feedback_status_changes" ADD COLUMN "notified_at" timestamp;--> statement-breakpoint
-- Changes made before status mail existed are settled: their followers are never mailed about them.
UPDATE "mocco_feedback_status_changes" SET "notified_at" = "created_at";--> statement-breakpoint
ALTER TABLE "mocco_feedback_status_mails" ADD CONSTRAINT "mocco_feedback_status_mails_status_change_id_mocco_feedback_status_changes_id_fk" FOREIGN KEY ("status_change_id") REFERENCES "public"."mocco_feedback_status_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_feedback_status_mails_change_end_user_uq" ON "mocco_feedback_status_mails" USING btree ("status_change_id","end_user_id");--> statement-breakpoint
CREATE INDEX "mocco_feedback_status_mails_queued_idx" ON "mocco_feedback_status_mails" USING btree ("created_at") WHERE "mocco_feedback_status_mails"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "mocco_feedback_status_changes_unnotified_idx" ON "mocco_feedback_status_changes" USING btree ("created_at") WHERE "mocco_feedback_status_changes"."notified_at" IS NULL;