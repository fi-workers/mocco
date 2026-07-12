CREATE TABLE "mocco_pipeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"raw_yaml" text NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mocco_pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_pipeline_versions" ADD CONSTRAINT "mocco_pipeline_versions_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_pipeline_versions" ADD CONSTRAINT "mocco_pipeline_versions_pipeline_id_mocco_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."mocco_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_pipelines" ADD CONSTRAINT "mocco_pipelines_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_pipeline_versions_pipeline_hash_uq" ON "mocco_pipeline_versions" USING btree ("pipeline_id","content_hash");--> statement-breakpoint
CREATE INDEX "mocco_pipeline_versions_pipeline_id_idx" ON "mocco_pipeline_versions" USING btree ("pipeline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_pipelines_workspace_name_uq" ON "mocco_pipelines" USING btree ("workspace_id","name");