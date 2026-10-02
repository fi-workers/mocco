CREATE TABLE "mocco_flag_segments" (
	"environment_id" uuid NOT NULL,
	"key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"included_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "mocco_flag_segments_pk" PRIMARY KEY("environment_id","key")
);
--> statement-breakpoint
ALTER TABLE "mocco_flag_configs" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mocco_flag_configs" ADD COLUMN "rollout" jsonb;--> statement-breakpoint
ALTER TABLE "mocco_flag_segments" ADD CONSTRAINT "mocco_flag_segments_environment_fk" FOREIGN KEY ("environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Diff entries written before segments named their subject as `flagKey`; give them the
-- `{subject, key}` shape the changeset history reads. (The audit log keeps its original
-- payloads: rewriting them would break its hash chain.)
UPDATE "mocco_flag_changesets" SET "diff" = (
	SELECT coalesce(jsonb_agg(
		CASE WHEN entry ? 'subject' THEN entry
		ELSE jsonb_build_object('subject', 'flag', 'key', entry->'flagKey', 'field', entry->'field', 'before', entry->'before', 'after', entry->'after')
		END ORDER BY position), '[]'::jsonb)
	FROM jsonb_array_elements("diff") WITH ORDINALITY AS item(entry, position)
) WHERE EXISTS (SELECT 1 FROM jsonb_array_elements("diff") AS item(entry) WHERE NOT entry ? 'subject');
