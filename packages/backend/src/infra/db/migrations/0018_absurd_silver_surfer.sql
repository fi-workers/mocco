CREATE TABLE "mocco_ops_canaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canary_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"sent_at" timestamp NOT NULL,
	"ingest_status" integer,
	"error" text,
	"delivered_at" timestamp,
	"heartbeat_at" timestamp,
	"heartbeat_status" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_notification_deliveries" ADD COLUMN "canary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_ops_canaries_canary_id_uq" ON "mocco_ops_canaries" USING btree ("canary_id");--> statement-breakpoint
CREATE INDEX "mocco_ops_canaries_sent_at_idx" ON "mocco_ops_canaries" USING btree ("sent_at");