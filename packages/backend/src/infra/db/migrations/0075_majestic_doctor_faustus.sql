CREATE TABLE "mocco_help_segment_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"source_hash" text NOT NULL,
	"text" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_segment_memory_origin_check" CHECK ("mocco_help_segment_memory"."origin" IN ('machine','human'))
);
--> statement-breakpoint
CREATE TABLE "mocco_help_translation_usage" (
	"workspace_id" uuid NOT NULL,
	"month" date NOT NULL,
	"characters" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mocco_help_translation_usage_pk" PRIMARY KEY("workspace_id","month")
);
--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" DROP CONSTRAINT "mocco_help_revisions_kind_check";--> statement-breakpoint
ALTER TABLE "mocco_help_translations" DROP CONSTRAINT "mocco_help_translations_state_check";--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD COLUMN "proposal_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD COLUMN "proposal_source_hash" text;--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD COLUMN "claimed_until" timestamp;--> statement-breakpoint
ALTER TABLE "mocco_help_segment_memory" ADD CONSTRAINT "mocco_help_segment_memory_site_fk" FOREIGN KEY ("project_id") REFERENCES "public"."mocco_help_sites"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_help_translation_usage" ADD CONSTRAINT "mocco_help_translation_usage_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_help_segment_memory_key_uq" ON "mocco_help_segment_memory" USING btree ("project_id","locale","source_hash","origin");--> statement-breakpoint
ALTER TABLE "mocco_help_revisions" ADD CONSTRAINT "mocco_help_revisions_kind_check" CHECK ("mocco_help_revisions"."kind" IN ('source_edit','restore','import','machine','human_edit','proposal'));--> statement-breakpoint
ALTER TABLE "mocco_help_translations" ADD CONSTRAINT "mocco_help_translations_state_check" CHECK ("mocco_help_translations"."state" IN ('pending','translating','auto','reviewed','failed'));