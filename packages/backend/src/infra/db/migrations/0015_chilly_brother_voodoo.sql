CREATE TABLE "mocco_inbound_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"source_event" text,
	"outcome" text NOT NULL,
	"reason" text,
	"event_type" text,
	"domain_event_id" uuid,
	"normalized" jsonb,
	"received_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_inbound_receipts_seq_uq" UNIQUE("seq"),
	CONSTRAINT "mocco_inbound_receipts_outcome_check" CHECK ("mocco_inbound_receipts"."outcome" IN ('published','ignored','over_quota','pending'))
);
--> statement-breakpoint
CREATE TABLE "mocco_inbound_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"ingest_key" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_received_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_inbound_sources_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_inbound_sources_kind_check" CHECK ("mocco_inbound_sources"."kind" IN ('sentry','vercel','github')),
	CONSTRAINT "mocco_inbound_sources_status_check" CHECK ("mocco_inbound_sources"."status" IN ('active','paused'))
);
--> statement-breakpoint
ALTER TABLE "mocco_inbound_receipts" ADD CONSTRAINT "mocco_inbound_receipts_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_inbound_receipts" ADD CONSTRAINT "mocco_inbound_receipts_domain_event_id_mocco_domain_events_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "public"."mocco_domain_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_inbound_receipts" ADD CONSTRAINT "mocco_inbound_receipts_source_workspace_fk" FOREIGN KEY ("source_id","workspace_id") REFERENCES "public"."mocco_inbound_sources"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_inbound_sources" ADD CONSTRAINT "mocco_inbound_sources_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_inbound_receipts_source_external_id_uq" ON "mocco_inbound_receipts" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_workspace_seq_idx" ON "mocco_inbound_receipts" USING btree ("workspace_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_source_seq_idx" ON "mocco_inbound_receipts" USING btree ("source_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_workspace_published_idx" ON "mocco_inbound_receipts" USING btree ("workspace_id","received_at") WHERE "mocco_inbound_receipts"."outcome" = 'published';--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_pending_idx" ON "mocco_inbound_receipts" USING btree ("received_at") WHERE "mocco_inbound_receipts"."outcome" = 'pending';--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_received_at_idx" ON "mocco_inbound_receipts" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "mocco_inbound_receipts_domain_event_idx" ON "mocco_inbound_receipts" USING btree ("domain_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_inbound_sources_ingest_key_uq" ON "mocco_inbound_sources" USING btree ("ingest_key");--> statement-breakpoint
CREATE INDEX "mocco_inbound_sources_workspace_idx" ON "mocco_inbound_sources" USING btree ("workspace_id");