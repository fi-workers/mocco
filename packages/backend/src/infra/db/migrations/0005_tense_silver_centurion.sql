CREATE TABLE "mocco_commit_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_id" uuid NOT NULL,
	"raw_yaml" text NOT NULL,
	"parsed_json" jsonb,
	"valid" boolean NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_commit_configs" ADD CONSTRAINT "mocco_commit_configs_commit_id_mocco_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."mocco_commits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_commit_configs_commit_uq" ON "mocco_commit_configs" USING btree ("commit_id");