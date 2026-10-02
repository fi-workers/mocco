ALTER TABLE "mocco_flag_changesets" DROP CONSTRAINT "mocco_flag_changesets_state_check";--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD COLUMN "requirements" jsonb;--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD CONSTRAINT "mocco_flag_changesets_approval_request_id_mocco_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."mocco_approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_flag_changesets_pending_idx" ON "mocco_flag_changesets" USING btree ("expires_at") WHERE "mocco_flag_changesets"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "mocco_flag_changesets" ADD CONSTRAINT "mocco_flag_changesets_state_check" CHECK ("mocco_flag_changesets"."state" IN ('pending','applied','rejected','conflicted','superseded','withdrawn','expired'));