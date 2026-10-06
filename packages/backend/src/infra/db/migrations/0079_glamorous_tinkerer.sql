CREATE TABLE "mocco_help_glossary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"term" text NOT NULL,
	"rule" text NOT NULL,
	"translations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_glossary_terms_rule_check" CHECK ("mocco_help_glossary_terms"."rule" IN ('keep','fixed'))
);
--> statement-breakpoint
ALTER TABLE "mocco_help_sites" ADD COLUMN "glossary_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD COLUMN "glossary_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD COLUMN "proposal_glossary_hash" text;--> statement-breakpoint
ALTER TABLE "mocco_help_glossary_terms" ADD CONSTRAINT "mocco_help_glossary_terms_site_fk" FOREIGN KEY ("project_id") REFERENCES "public"."mocco_help_sites"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_glossary_terms_term_uq" ON "mocco_help_glossary_terms" USING btree ("project_id",lower("term"));