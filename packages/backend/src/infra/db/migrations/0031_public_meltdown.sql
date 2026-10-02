ALTER TABLE "mocco_api_keys" ADD COLUMN "flag_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "mocco_api_keys" ADD CONSTRAINT "mocco_api_keys_flag_environment_fk" FOREIGN KEY ("flag_environment_id","workspace_id") REFERENCES "public"."mocco_flag_environments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- flags:read did nothing before this migration (no route read it), and a key holding it now
-- must name an environment; drop it from existing keys so the check below can hold.
UPDATE "mocco_api_keys" SET "scopes" = array_remove("scopes", 'flags:read') WHERE 'flags:read' = ANY("scopes");--> statement-breakpoint
ALTER TABLE "mocco_api_keys" ADD CONSTRAINT "mocco_api_keys_flag_environment_check" CHECK (('flags:read' = ANY("mocco_api_keys"."scopes")) = ("mocco_api_keys"."flag_environment_id" IS NOT NULL));