CREATE TABLE "mocco_status_component_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_component_groups_id_page_uq" UNIQUE("id","page_id")
);
--> statement-breakpoint
CREATE TABLE "mocco_status_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"group_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"position" integer NOT NULL,
	"status" text DEFAULT 'operational' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_components_status_check" CHECK ("mocco_status_components"."status" IN ('operational','maintenance','degraded','partial_outage','major_outage'))
);
--> statement-breakpoint
CREATE TABLE "mocco_status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_status_pages_scope_uq" UNIQUE("id","workspace_id","project_id"),
	CONSTRAINT "mocco_status_pages_slug_check" CHECK ("mocco_status_pages"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "mocco_status_component_groups" ADD CONSTRAINT "mocco_status_component_groups_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_components" ADD CONSTRAINT "mocco_status_components_page_fk" FOREIGN KEY ("page_id","workspace_id","project_id") REFERENCES "public"."mocco_status_pages"("id","workspace_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_components" ADD CONSTRAINT "mocco_status_components_group_fk" FOREIGN KEY ("group_id","page_id") REFERENCES "public"."mocco_status_component_groups"("id","page_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_status_pages" ADD CONSTRAINT "mocco_status_pages_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mocco_status_component_groups_page_idx" ON "mocco_status_component_groups" USING btree ("page_id","position");--> statement-breakpoint
CREATE INDEX "mocco_status_components_page_idx" ON "mocco_status_components" USING btree ("page_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_status_pages_slug_uq" ON "mocco_status_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "mocco_status_pages_project_idx" ON "mocco_status_pages" USING btree ("project_id");