ALTER TABLE "mocco_status_locations" ADD COLUMN "unhealthy_since" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_status_monitors" ADD COLUMN "tls_warned_days" integer;