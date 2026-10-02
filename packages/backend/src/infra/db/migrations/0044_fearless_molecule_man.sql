CREATE TABLE "mocco_help_node_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"collection_id" uuid,
	"section_id" uuid,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"source_title" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_node_translations_node_check" CHECK (("mocco_help_node_translations"."collection_id" IS NULL) <> ("mocco_help_node_translations"."section_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mocco_help_node_translations" ADD CONSTRAINT "mocco_help_node_translations_collection_fk" FOREIGN KEY ("collection_id","workspace_id") REFERENCES "public"."mocco_help_collections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_node_translations" ADD CONSTRAINT "mocco_help_node_translations_section_fk" FOREIGN KEY ("section_id","workspace_id") REFERENCES "public"."mocco_help_sections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_node_translations_collection_uq" ON "mocco_help_node_translations" USING btree ("collection_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_node_translations_section_uq" ON "mocco_help_node_translations" USING btree ("section_id","locale");