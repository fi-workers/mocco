CREATE TABLE "mocco_ota_adoption_daily" (
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"update_id" uuid NOT NULL,
	"day" date NOT NULL,
	"active_devices" integer DEFAULT 0 NOT NULL,
	"new_devices" integer DEFAULT 0 NOT NULL,
	"emergency_launches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mocco_ota_adoption_daily_pk" PRIMARY KEY("app_id","update_id","day")
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_client_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"update_id" uuid,
	"client_id_hash" text NOT NULL,
	"type" text NOT NULL,
	"detail" jsonb,
	"occurred_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_ota_client_events_type_check" CHECK ("mocco_ota_client_events"."type" IN ('launched','emergency_launch','error'))
);
--> statement-breakpoint
CREATE TABLE "mocco_ota_devices" (
	"workspace_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"client_id_hash" text NOT NULL,
	"platform" text NOT NULL,
	"runtime_version" text NOT NULL,
	"channel" text NOT NULL,
	"current_update_id" uuid,
	"embedded_update_id" uuid,
	"first_seen_at" timestamp NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	CONSTRAINT "mocco_ota_devices_pk" PRIMARY KEY("app_id","client_id_hash")
);
--> statement-breakpoint
ALTER TABLE "mocco_ota_apps" ADD COLUMN "device_pepper" text DEFAULT md5(random()::text || clock_timestamp()::text) NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_ota_adoption_daily" ADD CONSTRAINT "mocco_ota_adoption_daily_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_client_events" ADD CONSTRAINT "mocco_ota_client_events_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_ota_devices" ADD CONSTRAINT "mocco_ota_devices_app_fk" FOREIGN KEY ("app_id","workspace_id") REFERENCES "public"."mocco_ota_apps"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_ota_client_events_app_idx" ON "mocco_ota_client_events" USING btree ("app_id","update_id","occurred_at");--> statement-breakpoint
CREATE INDEX "mocco_ota_client_events_occurred_idx" ON "mocco_ota_client_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "mocco_ota_devices_update_idx" ON "mocco_ota_devices" USING btree ("app_id","current_update_id","last_seen_at");