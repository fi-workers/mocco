ALTER TABLE "mocco_status_monitors" ADD COLUMN "key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_monitors_project_key_uq" ON "mocco_status_monitors" USING btree ("project_id","key");--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD CONSTRAINT "mocco_status_monitors_key_check" CHECK ("mocco_status_monitors"."key" ~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$');