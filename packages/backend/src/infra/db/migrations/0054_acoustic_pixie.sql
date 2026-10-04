CREATE TABLE "mocco_status_page_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"etag" text NOT NULL,
	"body" jsonb NOT NULL,
	"built_at" timestamp NOT NULL,
	"uploaded_at" timestamp,
	"upload_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD COLUMN "visibility" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_status_pages" ADD COLUMN "dirty_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_status_pages" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_status_pages" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "mocco_status_page_snapshots" ADD CONSTRAINT "mocco_status_page_snapshots_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_page_snapshots_page_version_uq" ON "mocco_status_page_snapshots" USING btree ("page_id","version");--> statement-breakpoint
ALTER TABLE "mocco_status_incidents" ADD CONSTRAINT "mocco_status_incidents_visibility_check" CHECK ("mocco_status_incidents"."visibility" IN ('draft','published'));