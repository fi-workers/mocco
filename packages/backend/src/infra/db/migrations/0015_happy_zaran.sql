CREATE TABLE "mocco_discord_rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"blocked_until" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"external_id" text NOT NULL,
	"secret_sealed" text,
	"status" text DEFAULT 'active' NOT NULL,
	"disabled_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_notification_channels_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_notification_channels_kind_check" CHECK ("mocco_notification_channels"."kind" IN ('discord')),
	CONSTRAINT "mocco_notification_channels_status_check" CHECK ("mocco_notification_channels"."status" IN ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "mocco_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid,
	"event_id" uuid NOT NULL,
	"rule_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_code" integer,
	"error" text,
	"external_message_id" text,
	"message" jsonb NOT NULL,
	"next_attempt_at" timestamp,
	"sending_at" timestamp,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_notification_deliveries_status_check" CHECK ("mocco_notification_deliveries"."status" IN ('queued','sending','sent','failed','suppressed')),
	CONSTRAINT "mocco_notification_deliveries_attempts_check" CHECK ("mocco_notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mocco_notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"source_id" uuid,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_notification_channels" ADD CONSTRAINT "mocco_notification_channels_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_notification_deliveries" ADD CONSTRAINT "mocco_notification_deliveries_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_notification_deliveries" ADD CONSTRAINT "mocco_notification_deliveries_channel_id_mocco_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."mocco_notification_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_notification_deliveries" ADD CONSTRAINT "mocco_notification_deliveries_event_id_mocco_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."mocco_domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_notification_deliveries" ADD CONSTRAINT "mocco_notification_deliveries_rule_id_mocco_notification_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."mocco_notification_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_notification_rules" ADD CONSTRAINT "mocco_notification_rules_channel_workspace_fk" FOREIGN KEY ("channel_id","workspace_id") REFERENCES "public"."mocco_notification_channels"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_notification_channels_workspace_kind_external_uq" ON "mocco_notification_channels" USING btree ("workspace_id","kind","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_notification_deliveries_event_channel_uq" ON "mocco_notification_deliveries" USING btree ("event_id","channel_id");--> statement-breakpoint
CREATE INDEX "mocco_notification_deliveries_workspace_created_at_idx" ON "mocco_notification_deliveries" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mocco_notification_deliveries_workspace_sent_at_idx" ON "mocco_notification_deliveries" USING btree ("workspace_id","sent_at") WHERE "mocco_notification_deliveries"."sent_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_notification_deliveries_channel_idx" ON "mocco_notification_deliveries" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "mocco_notification_deliveries_rule_idx" ON "mocco_notification_deliveries" USING btree ("rule_id") WHERE "mocco_notification_deliveries"."rule_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mocco_notification_deliveries_unsettled_idx" ON "mocco_notification_deliveries" USING btree ("created_at") WHERE "mocco_notification_deliveries"."status" IN ('queued','sending');--> statement-breakpoint
CREATE INDEX "mocco_notification_rules_channel_idx" ON "mocco_notification_rules" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "mocco_notification_rules_workspace_idx" ON "mocco_notification_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_notification_rules_channel_rule_uq" ON "mocco_notification_rules" USING btree ("channel_id","event_type",coalesce("source_id", '00000000-0000-0000-0000-000000000000'::uuid),"filter");