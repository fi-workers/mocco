CREATE TABLE "mocco_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"product" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"visibility" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ready_at" timestamp,
	"deleted_at" timestamp,
	CONSTRAINT "mocco_objects_visibility_check" CHECK ("mocco_objects"."visibility" IN ('public','private')),
	CONSTRAINT "mocco_objects_status_check" CHECK ("mocco_objects"."status" IN ('pending','ready','deleted')),
	CONSTRAINT "mocco_objects_size_check" CHECK ("mocco_objects"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mocco_objects" ADD CONSTRAINT "mocco_objects_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_objects" ADD CONSTRAINT "mocco_objects_created_by_user_id_mocco_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."mocco_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_objects" ADD CONSTRAINT "mocco_objects_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_objects_key_uq" ON "mocco_objects" USING btree ("key");--> statement-breakpoint
CREATE INDEX "mocco_objects_workspace_product_idx" ON "mocco_objects" USING btree ("workspace_id","product");--> statement-breakpoint
CREATE INDEX "mocco_objects_status_created_idx" ON "mocco_objects" USING btree ("status","created_at");