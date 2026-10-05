ALTER TABLE "mocco_approval_requests" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_approval_requests" ADD CONSTRAINT "mocco_approval_requests_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."mocco_projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: requests opened before project_id existed get the project of their subject.
UPDATE "mocco_approval_requests" r SET "project_id" = e."project_id"
  FROM "mocco_flag_environments" e
  WHERE r."project_id" IS NULL AND r."workspace_id" = e."workspace_id"
    AND r."subject_type" IN ('flags.changeset', 'flags.kill') AND e."id"::text = r."action"->>'environmentId';--> statement-breakpoint
UPDATE "mocco_approval_requests" r SET "project_id" = e."project_id"
  FROM "mocco_flag_environments" e
  WHERE r."project_id" IS NULL AND r."workspace_id" = e."workspace_id"
    AND r."subject_type" = 'flags.change_gate' AND e."id"::text = r."subject_id";--> statement-breakpoint
UPDATE "mocco_approval_requests" r SET "project_id" = a."project_id"
  FROM "mocco_project_apps" a
  WHERE r."project_id" IS NULL AND r."workspace_id" = a."workspace_id"
    AND r."subject_type" = 'ota.version_policy' AND a."id"::text = r."subject_id";--> statement-breakpoint
UPDATE "mocco_approval_requests" r SET "project_id" = o."project_id"
  FROM "mocco_ota_channels" c JOIN "mocco_ota_apps" o ON o."id" = c."app_id"
  WHERE r."project_id" IS NULL AND r."workspace_id" = o."workspace_id"
    AND r."subject_type" IN ('ota.channel_policy', 'ota.channel_change') AND c."id"::text = r."subject_id";
