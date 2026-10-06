CREATE TABLE "mocco_status_subscriber_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sending_at" timestamp,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_subscriber_deliveries_kind_check" CHECK ("mocco_status_subscriber_deliveries"."kind" IN ('confirmation','incident_update','maintenance')),
	CONSTRAINT "mocco_status_subscriber_deliveries_status_check" CHECK ("mocco_status_subscriber_deliveries"."status" IN ('queued','sending','sent','failed','suppressed')),
	CONSTRAINT "mocco_status_subscriber_deliveries_attempts_check" CHECK ("mocco_status_subscriber_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mocco_status_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"email" text,
	"webhook_url" text,
	"webhook_secret_sealed" text,
	"component_ids" uuid[],
	"locale" text DEFAULT 'en' NOT NULL,
	"confirmed_at" timestamp,
	"unsubscribed_at" timestamp,
	"confirmation_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_subscribers_scope_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "mocco_status_subscribers_channel_check" CHECK ("mocco_status_subscribers"."channel" IN ('email','webhook')),
	CONSTRAINT "mocco_status_subscribers_locale_check" CHECK ("mocco_status_subscribers"."locale" IN ('en','ko')),
	CONSTRAINT "mocco_status_subscribers_target_check" CHECK (("mocco_status_subscribers"."channel" = 'email' AND "mocco_status_subscribers"."email" IS NOT NULL AND "mocco_status_subscribers"."email" = lower("mocco_status_subscribers"."email") AND "mocco_status_subscribers"."webhook_url" IS NULL AND "mocco_status_subscribers"."webhook_secret_sealed" IS NULL) OR ("mocco_status_subscribers"."channel" = 'webhook' AND "mocco_status_subscribers"."webhook_url" IS NOT NULL AND "mocco_status_subscribers"."webhook_secret_sealed" IS NOT NULL AND "mocco_status_subscribers"."email" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mocco_status_subscriber_deliveries" ADD CONSTRAINT "mocco_status_subscriber_deliveries_subscriber_fk" FOREIGN KEY ("subscriber_id","workspace_id") REFERENCES "public"."mocco_status_subscribers"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_subscribers" ADD CONSTRAINT "mocco_status_subscribers_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_subscriber_deliveries_dedupe_uq" ON "mocco_status_subscriber_deliveries" USING btree ("subscriber_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "mocco_status_subscriber_deliveries_created_at_idx" ON "mocco_status_subscriber_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_subscribers_page_email_uq" ON "mocco_status_subscribers" USING btree ("page_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_subscribers_page_webhook_uq" ON "mocco_status_subscribers" USING btree ("page_id","webhook_url");--> statement-breakpoint
CREATE INDEX "mocco_status_subscribers_active_idx" ON "mocco_status_subscribers" USING btree ("page_id") WHERE "mocco_status_subscribers"."confirmed_at" IS NOT NULL AND "mocco_status_subscribers"."unsubscribed_at" IS NULL;