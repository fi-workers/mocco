CREATE TABLE "mocco_credential_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"pipeline" text NOT NULL,
	"gate_name" text NOT NULL,
	"provider" text NOT NULL,
	"role" text NOT NULL,
	"max_ttl_seconds" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mocco_credential_grants" ADD CONSTRAINT "mocco_credential_grants_workspace_id_mocco_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."mocco_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocco_credential_grants" ADD CONSTRAINT "mocco_credential_grants_repo_id_mocco_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."mocco_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mocco_credential_grants_uq" ON "mocco_credential_grants" USING btree ("workspace_id","repo_id","pipeline","gate_name","provider","role");