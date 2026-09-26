CREATE TABLE "mocco_domain_event_deliveries" (
	"event_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"delivered_at" timestamp NOT NULL,
	CONSTRAINT "mocco_domain_event_deliveries_pk" PRIMARY KEY("event_id","subscriber")
);
--> statement-breakpoint
CREATE TABLE "mocco_domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_domain_events_seq_uq" UNIQUE("seq")
);
--> statement-breakpoint
ALTER TABLE "mocco_domain_event_deliveries" ADD CONSTRAINT "mocco_domain_event_deliveries_event_id_mocco_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."mocco_domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_domain_events" ADD CONSTRAINT "mocco_domain_events_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_domain_events" ADD CONSTRAINT "mocco_domain_events_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_domain_events_workspace_occurred_at_idx" ON "mocco_domain_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "mocco_domain_events_type_occurred_at_idx" ON "mocco_domain_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "mocco_domain_events_occurred_at_idx" ON "mocco_domain_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_domain_events_workspace_dedupe_key_uq" ON "mocco_domain_events" USING btree ("workspace_id","dedupe_key") WHERE "mocco_domain_events"."dedupe_key" IS NOT NULL;